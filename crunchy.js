#!/usr/bin/env node

// build-in
const path = require('path');
const fs = require('fs');
const url = require('url');

// package program
const packageJson = require('./package.json');
const ua = {headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; WOW64; rv:65.0) Gecko/20100101 Firefox/65.0'}};
console.log(`\n=== Crunchyroll Downloader NX ${packageJson.version} ===\n`);

// config
const modulesFolder = __dirname + '/modules';
const configFile = path.join(modulesFolder,'config.main.yml');
const sessionFile = path.join(modulesFolder,'config.session.yml');

// plugins
const yargs = require('yargs');
const shlp = require('sei-helper');
const got = require('got').extend(ua);
const agent = require('proxy-agent');
const yaml = require('yaml');
const xhtml2js = shlp.xhtml2js;

// m3u8 and subs
const m3u8 = require('m3u8-parsed');
const streamdl = require('hls-download');
const fontsData = require(modulesFolder+'/module.fontsData');
const crunchySubs = require(modulesFolder+'/module.crunchySubs');

// params
let cfg = {};
let session = {};

if(!fs.existsSync(configFile)){
    console.log(`[ERROR] config file not found!`);
    process.exit();
}
else{
    cfg = yaml.parse(
        fs.readFileSync(configFile, 'utf8')
            .replace(/\${__dirname}/g,__dirname.replace(/\\/g,'/'))
    );
}

if(fs.existsSync(sessionFile)){
    session = yaml.parse(fs.readFileSync(sessionFile, 'utf8'));
}

// langs
const dubLangs = {
    'English':    'eng',
    'Spanish':    'spa',
    'French':     'fre',
    'Portuguese': 'por',
    'Arabic':     'ara',
    'Italian':    'ita',
    'German':     'ger',
    'Russian':    'rus',
    'Turkish':    'tur',
    'Japanese':   'jpn',
    '':           'unk',
};
// dub langs
const isoLangs = [];
for(let lk of Object.keys(dubLangs)){
    isoLangs.push(dubLangs[lk]);
}
// dubRegex
const dubRegex =
    new RegExp(`\\((${Object.keys(dubLangs).join('|')}) Dub\\)$`);
// subs codes
const langCodes = {
    'en - us': ['eng','English (US)'],
    'es - la': ['spa','Spanish (Latin American)'],
    'es - es': ['spa','Spanish'],
    'fr - fr': ['fre','French'],
    'pt - br': ['por','Portuguese (Brazilian)'],
    'pt - pt': ['por','Portuguese'],
    'ar - me': ['ara','Arabic'],
    'it - it': ['ita','Italian'],
    'de - de': ['ger','German'],
    'ru - ru': ['rus','Russian'],
    'tr - tr': ['tur','Turkish'],
    '':        ['unk','Unknown']
};
// subs filter codes
const subsFilterLangs = ['all','none'];
for(let lc of Object.keys(langCodes)){
    lc = lc.match(/(\w{2}) - (\w{2})/);
    if(lc){
        lc = `${lc[1]}${lc[2].toUpperCase()}`;
        subsFilterLangs.push(lc);
    }
}

// args
let argv = yargs
    // main
    .wrap(Math.min(100))
    .usage('Usage: $0 [options]')
    .help(false).version(false)
    // auth
    .describe('auth','Enter auth mode')
    // fonts
    .describe('dlfonts','Download all required fonts for mkv muxing')
    // search
    .describe('search','Search show ids')
    .describe('search2','Search show ids (multi-language, experimental)')
    // req params
    .describe('s','Sets the show id')
    .describe('e','Select episode ids (comma-separated, hyphen-sequence)')
    // quality
    .describe('q','Video Quality')
    .choices('q',['240p','360p','480p','720p','1080p','max'])
    .default('q',(cfg.cli.videoQuality?cfg.cli.videoQuality:'720p'))
    // set dub
    .describe('dub','Set audio language by language code (sometimes not detect correctly)')
    .choices('dub', [...new Set(isoLangs)])
    .default('dub', (cfg.cli.dubLanguage?cfg.cli.dubLanguage:'jpn'))
    // server
    .describe('x','Select server')
    .choices('x', [1, 2, 3, 4])
    .default('x', (cfg.cli.nServer?cfg.cli.nServer:1))
    // oldsubs api
    .describe('oldsubs','Use old api for fetching subtitles')
    .boolean('oldsubs')
    .default('oldsubs', cfg.cli.oldSubs)
    // muxing subs
    .describe('dlsubs','Download subtitles by language tag')
    .choices('dlsubs', subsFilterLangs)
    .default('dlsubs', (cfg.cli.dlSubs?cfg.cli.dlSubs:'all'))
    // skip
    .describe('skipdl','Skip downloading video (for downloading subtitles only)')
    .boolean('skipdl')
    .alias('skipdl','novids')
    .describe('skipmux','Skip muxing video and subtitles')
    .boolean('skipmux')
    // proxy
    .describe('proxy','Set http(s)/socks proxy WHATWG url')
    .default('proxy', (cfg.cli.proxy?cfg.cli.proxy:false))
    .describe('proxy-auth','Colon-separated username and password for proxy')
    .default('proxy-auth', (cfg.cli.proxy_auth?cfg.cli.proxy_auth:false))
    .describe('ssp','Don\'t use proxy for stream downloading')
    .boolean('ssp')
    .default('ssp', (cfg.cli.proxy_ssp?cfg.cli.proxy_ssp:false))
    // muxing
    .describe('mp4','Mux into mp4')
    .boolean('mp4')
    .default('mp4',cfg.cli.mp4mux)
    .describe('mks','Add subtitles to mkv/mp4 (if available)')
    .boolean('mks')
    .default('mks',cfg.cli.muxSubs)
    // set title
    .describe('a','Filenaming: Release group')
    .default('a',cfg.cli.releaseGroup)
    .describe('t','Filenaming: Series title override')
    .describe('ep','Filenaming: Episode number override (ignored in batch mode)')
    .describe('suffix','Filenaming: Filename suffix override (first "SIZEp" will be replaced with actual video size)')
    .default('suffix',cfg.cli.fileSuffix)
    // util
    .describe('nocleanup','Move temporary files to trash folder instead of deleting')
    .boolean('nocleanup')
    .default('nocleanup',cfg.cli.noCleanUp)
    // help
    .describe('help','Show this help')
    .boolean('help')
    .alias('help','h')
    .argv;

// fn variables
let audDubT  = '',
    audDubE  = '',
    fnTitle  = '',
    fnEpNum  = '',
    fnSuffix = '',
    fnOutput = '',
    isBatch  = false,
    tsDlPath = false,
    sxList   = [];

// go to work folder
try {
    fs.accessSync(cfg.dir.content, fs.R_OK | fs.W_OK)
}
catch (e) {
    console.log(e);
    console.log(`[ERROR] %s`,e.messsage);
    process.exit();
}
process.chdir(cfg.dir.content);

// api script urls
const domain    = 'https://www.crunchyroll.com';
const apidomain = 'https://api.crunchyroll.com';

const api = {
    search1:     `${domain}/ajax/?req=RpcApiSearch_GetSearchCandidates`,
    search2:     `${domain}/search_page`,
    search3:     `${apidomain}/autocomplete.0.json`,
    session:     `${apidomain}/start_session.0.json`,
    collectins:  `${apidomain}/list_collections.0.json`,
    rss_cid:     `${domain}/syndication/feed?type=episodes&lang=enUS&id=`,
    rss_gid:     `${domain}/syndication/feed?type=episodes&lang=enUS&group_id=`,
    media_page:  `${domain}/media-`,
    series_page: `${domain}/series-`,
    subs_list:   `${domain}/xml/?req=RpcApiSubtitle_GetListing&media_id=`,
    subs_file:   `${domain}/xml/?req=RpcApiSubtitle_GetXml&subtitle_script_id=`,
    auth:        `${domain}/xml/?req=RpcApiUser_Login`,
    // ${domain}/showseriesmedia?id=24631
    // ${domain}/{GROUP_URL}/videos,
};

// select mode
if(argv.auth){
    doAuth();
}
else if(argv.dlfonts){
    getFonts();
}
else if(argv.search && argv.search.length > 2){
    doSearch();
}
else if(argv.search2 && argv.search2.length > 2){
    doSearch2();
}
else if(argv.s && !isNaN(parseInt(argv.s,10)) && parseInt(argv.s,10) > 0){
    getShowById();
}
else{
    yargs.showHelp();
    process.exit();
}

async function doAuth(){
    console.log(`[INFO] Authentication`);
    const iLogin = await shlp.question(`[Q] LOGIN/EMAIL`);
    const iPsswd = await shlp.question(`[Q] PASSWORD   `);
    const authData = new URLSearchParams({
        name: iLogin,
        password: iPsswd
    });
    let auth = await getData(api.auth,{ method: 'POST', body: authData.toString(), useProxy: true, skipCookies: true });
    if(!auth.ok){
        console.log(`[ERROR] Authentication failed!`);
        return;
    }
    setNewCookie(auth.res.headers['set-cookie'], true);
    console.log(`[INFO] Authentication successful!`);
}

async function getFonts(){
    console.log(`[INFO] Downloading fonts...`);
    for(let f of Object.keys(fontsData.fonts)){
        let fontFile = fontsData.fonts[f];
        let fontLoc  = path.join(cfg.dir.fonts, fontFile);
        if(fs.existsSync(fontLoc) && fs.statSync(fontLoc).size != 0){
            console.log(`[INFO] ${f} (${fontFile}) already downloaded!`);
        }
        else{
            if(fs.existsSync(fontLoc) && fs.statSync(fontLoc).size == 0){
                fs.unlinkSync(fontLoc);
            }
            let fontUrl = fontsData.root + fontFile;
            let getFont = await getData(fontUrl, { useProxy: true, skipCookies: true, binary: true });
            if(getFont.ok){
                fs.writeFileSync(fontLoc, getFont.res.body);
                console.log(`[INFO] Downloaded: ${f} (${fontFile})`);
            }
            else{
                console.log(`[WARN] Failed to download: ${f} (${fontFile})`);
            }
        }
    }
    console.log(`[INFO] All required fonts downloaded!`);
}

async function doSearch(){
    // session
    let apiSession = '';
    if(session.session_id && checkSessId(session.session_id) && !argv.nosess){
        apiSession = session.session_id.value;
    }
    // seacrh params
    const params = new URLSearchParams({
        q: argv.search,
        clases: 'series',
        media_types: 'anime',
        fields: 'series.series_id,series.name,series.year',
        offset: argv.p ? (parseInt(argv.p)-1)*100 : 0,
        limit: 100,
        locale: 'enUS',
    });
    if(apiSession != ''){
        params.append('session_id', apiSession);
    }
    else{
        const sessionParams = new URLSearchParams({
            device_type:  'com.crunchyroll.windows.desktop',
            device_id  :  '00000000-0000-0000-0000-000000000000',
            access_token: 'LNDJgOit5yaRIWN',
        });
        let reqSession = await getData(`${api.session}?${sessionParams.toString()}`,{useProxy:true});
        if(!reqSession.ok){
            console.log(`[ERROR] Can't update session id!`);
            return;
        }
        reqSession = JSON.parse(reqSession.res.body);
        if(reqSession.error){
            console.log(`[ERROR] ${aniList.message}`);
        }
        else{
            argv.nosess = false;
            console.log(`[INFO] Your country: ${reqSession.data.country_code}\n`);
            apiSession = session.session_id.value;
            params.append('session_id', apiSession);
        }
    }
    // request
    let aniList = await getData(`${api.search3}?${params.toString()}`);
    if(!aniList.ok){
        console.log(`[ERROR] Can't get search data!`);
        return;
    }
    aniList = JSON.parse(aniList.res.body);
    if(aniList.error){
        console.log(`[ERROR] ${aniList.message}`);
    }
    else{
        if(aniList.data.length > 0){
            console.log(`[INFO] Search Results:`);
            for(let a of aniList.data){
                await printSeasons(a,apiSession);
            }
            console.log(`\n[INFO] Total results: ${aniList.data.length}\n`);
        }
        else{
            console.log(`[INFO] Nothing Found!`);
        }
    }
}

async function printSeasons(a,apiSession){
    console.log(`[SERIES] #${a.series_id} ${a.name}`,(a.year?`(${a.year})`:``));
    let collParams = new URLSearchParams({
        session_id: apiSession,
        series_id:  a.series_id,
        fields:     'collection.collection_id,collection.name',
        limit:      5000,
        offset:     0,
        locale:     'enUS',
    });
    let seasonList = await getData(`${api.collectins}?${collParams.toString()}`);
    if(seasonList.ok){
        seasonList = JSON.parse(seasonList.res.body);
        if(seasonList.error){
            console.log(`  [ERROR] Can't fetch seasons list: ${seasonList.message}`);
        }
        else{
            if(seasonList.data.length>0){
                for(let s of seasonList.data){
                    console.log(`  [S:${s.collection_id}] ${s.name}`);
                }
            }
            else{
                console.log(`  [ERROR] Seasons list is empty`);
            }
        }
    }
    else{
        console.log(`  [ERROR] Can't fetch seasons list (request failed)`);
    }
}

async function doSearch2(){
    // seacrh params
    const params = new URLSearchParams({
        q: argv.search2,
        sp: argv.p ? parseInt(argv.p) - 1 : 0,
        limit: 100,
        st: 'm'
    });
    // request
    let reqAniSearch  = await getData(`${api.search2}?${params.toString()}`,{useProxy:true});
    let reqRefAniList = await getData(`${api.search1}`);
    if(!reqAniSearch.ok || !reqRefAniList.ok){ return; }
    // parse fix
    let aniSearchSec  = reqAniSearch.res.body.replace(/^\/\*-secure-\n(.*)\n\*\/$/,'$1');
    let aniRefListSec = reqRefAniList.res.body.replace(/^\/\*-secure-\n(.*)\n\*\/$/,'$1');
    aniSearchSec = JSON.parse(aniSearchSec);
    aniRefListSec = JSON.parse(aniRefListSec);
    let totalResults = 0;
    // data
    const mainHtml = xhtml2js({ src: '<html>'+aniSearchSec.data.main_html+'</html>', el: 'body' }).$;
    const results0 = mainHtml.find('p');
    const results1 = results0.eq(0).text().trim();
    const results2 = results0.eq(1).text().trim();
    const resultsStr = results2 != '' ? results2 :
        results1 != '' ? results1 : 'NOTHING FOUND!';
    console.log(`[INFO] ${resultsStr}`);
    // seasons
    const searchData = mainHtml.find('li');
    for(let v=0; v<searchData.length; v++){
        let href  = searchData.eq(v).find('a')[0].attribs.href;
        let data  = aniRefListSec.data.filter(value => value.link == href).shift()
        let notLib = href.match(/^\/library\//) ? false : true;
        if(notLib && data.type == 'Series'){
            if(session.session_id && checkSessId(session.session_id) && !argv.nosess){
                await printSeasons({series_id: data.id, name: data.name},session.session_id.value);
            }
            else{
                console.log(`  [ERROR] Can't fetch seasons list, session_id cookie required`);
            }
            totalResults++;
        }
    }
    if(totalResults>0){
        console.log(`[INFO] Non-anime results is hidden`);
        console.log(`[INFO] Total results: ${totalResults}\n`);
    }
}

async function getShowById(){
    const epListRss = `${api.rss_cid}${argv.s}`;
    const epListReq = await getData(epListRss);
    if(!epListReq.ok){ return 0; }
    const src = epListReq.res.body;
    // title
    let seasonData = xhtml2js({ src, el: 'channel', isXml: true }).$;
    const vMainTitle = seasonData.find('title').eq(0).text().replace(/ Episodes$/i,'');
    const isSimulcast = seasonData.find('crunchyroll\\:simulcast').length > 0 ? true : false;
    // detect dub in title
    if(vMainTitle.match(dubRegex)){
        audDubT = dubLangs[vMainTitle.match(dubRegex)[1]];
        console.log(`[INFO] audio language code detected, setted to ${audDubT} for this title`);
    }
    // show title
    console.log(`[S:${argv.s}] ${vMainTitle}`,(isSimulcast?'[simulcast]':''));
    // episodes
    const epsList  = seasonData.find('item');
    const epsCount = epsList.length;
    let selEpsArr = [], spCount = 0, isSp = false;
    // selected
    let selEpsInp = argv.e ? argv.e.toString().split(',') : [], selEpsInpRanges = [''];
    let epsRegex  = /^((?:|E|S))(\d{1,3})$/i;
    selEpsInp = selEpsInp.map((e)=>{
        let eSplitNum, eFirstNum, eLastNum;
        if(e.match('-')){
            let eRegx = e.split('-');
            if( eRegx.length == 2
                    && eRegx[0].match(epsRegex)
                    && eRegx[1].match(/^\d{1,3}$/)
            ){
                eSplitNum = eRegx[0].match(epsRegex);
                eLetter = eSplitNum[1].match(/s/i) ? 'S' : 'E';
                eFirstNum = parseInt(eSplitNum[2]);
                eLastNum = parseInt(eRegx[1]);
                if(eFirstNum < eLastNum){
                    for(let i=eFirstNum;i<eLastNum+1;i++){
                         selEpsInpRanges.push(eLetter + i.toString().padStart(2,'0'));
                    }
                    return '';
                }
                else{
                    return eLetter + ( eFirstNum.toString().padStart(2,'0') );
                }
            }
            return '';
        }
        else if(e.match(epsRegex)){
            eSplitNum = e.match(epsRegex);
            eLetter = eSplitNum[1].match(/s/i) ? 'S' : 'E';
            eFirstNum = eLetter + eSplitNum[2].padStart(2,'0');
            return eFirstNum;
        }
        return '';
    });
    selEpsInp = [...new Set(selEpsInp.concat(selEpsInpRanges))].sort().slice(1);
    if(selEpsInp.length>1){
        isBatch = true;
    }
    // parse list
    epsList.each(function(i1, elem){
        let i2 = isSimulcast ? epsCount - i1 - 1 : i1;
        isSp = false;
        let epTitle = epsList.eq(i2).find('crunchyroll\\:episodeTitle').text();
        let epNum   = epsList.eq(i2).find('crunchyroll\\:episodeNumber').text();
        let airDate = new Date(epsList.eq(i2).find('crunchyroll\\:premiumPubDate').text());
        let airFree = new Date(epsList.eq(i2).find('crunchyroll\\:freePubDate').text());
        let subsArr = epsList.eq(i2).find('crunchyroll\\:subtitleLanguages').text();
        let dateNow = Date.now() + 1;
        if(!epNum.match(/^(\d+)$/)){
            isSp = true;
            spCount++;
            epNum = spCount.toString();
        }
        let epStr = ( isSp ? 'S' : 'E' ) + ( epNum.padStart(2,'0') );
        let mediaId = epsList.eq(i2).find('crunchyroll\\:mediaId').text();
        let selMark = '';
        if(selEpsInp.includes(epStr) && dateNow > airDate){
            selEpsArr.push({
                m: mediaId,
                t: vMainTitle,
                te: epTitle,
                e: epStr,
            });
            selMark = ' (selected)';
        }
        console.log(`  [${epStr}|${mediaId}] ${epTitle}${selMark}`);
        let dateStrPrem = shlp.dateString(airDate)
            + ( dateNow < airDate ? ` (in ${shlp.formatTime((airDate-dateNow)/1000)})` : '');
        let dateStrFree = shlp.dateString(airFree)
            + ( dateNow < airFree ? ` (in ${shlp.formatTime((airFree-dateNow)/1000)})` : '');
        console.log(`   - PremPubDate: ${dateStrPrem}`);
        console.log(`   - FreePubDate: ${dateStrFree}`);
        if(Boolean(subsArr)){
            console.log(`   - Subtitles: ${parseSubsString(subsArr)}`);
        }
    });
    console.log(`\n[INFO] Total videos: ${epsCount}\n`);
    if(selEpsArr.length > 0){
        for(let sm=0;sm<selEpsArr.length;sm++){
            await getMedia(selEpsArr[sm]);
        }
    }
}

function parseSubsString(subs){
    subs = subs.split(',');
    let subsStr = '';
    for(let lid=0;lid<subs.length;lid++){
        if ( !langCodes[subs[lid]] ) {
            console.log(`[ERROR] Language code for "${subs[lid]}" don't found.`);
        }
        else{
            subsStr += langCodes[subs[lid]][1] + (lid+1<subs.length?', ':'');
        }
    }
    return subsStr;
}

async function getMedia(mMeta){
    
    console.log(`Requesting: [${mMeta.m}] ${mMeta.t} - ${mMeta.e} - ${mMeta.te}`);
    audDubE = '';
    if(audDubT == '' && mMeta.te.match(dubRegex)){
        audDubE = dubLangs[mMeta.te.match(dubRegex)[1]];
        console.log(`[INFO] audio language code detected, setted to ${audDubE} for this episode`);
    }
    const mediaPage = await getData(`${api.media_page}${mMeta.m}`);
    if(!mediaPage.ok){ return; }
    
    let redirs = mediaPage.res.redirectUrls;
    if(redirs && redirs[redirs.length-1] == `${domain}/`){
        console.log(`[ERROR] Sorry, this video is not available in your region due to licensing restrictions.\n`);
        return;
    }
    
    let mediaData = mediaPage.res.body.match(/vilos.config.media = \{(.*)\};/);
    if(!mediaData){
        console.log(`[ERROR] CAN'T FETCH VIDEO INFO / PREMIUM LOCKED FOR YOUR REGION!`);
        return;
    }
    else{
        mediaData = mediaData[1];
    }
    mediaData = JSON.parse(`{${mediaData}}`);
    
    let epNum = mMeta.e;
    let metaEpNum = mediaData.metadata.episode_number;
    if(metaEpNum != '' && metaEpNum !== null){
        epNum = metaEpNum.match(/^\d+$/) ? metaEpNum.padStart(2,'0') : metaEpNum;
    }
    
    fnTitle = argv.t ? argv.t : mMeta.t;
    fnEpNum = !isBatch && argv.ep ? argv.ep : epNum;
    fnSuffix = argv.suffix.replace('SIZEp',argv.q);
    fnOutput = shlp.cleanupFilename(`[${argv.a}] ${fnTitle} - ${fnEpNum} [${fnSuffix}]`);
    let hlsStream = '', getOldSubs = false;
    
    let streams = mediaData.streams;
    let isClip  = false;
    
    for(let s=0;s<streams.length;s++){
        let isHls = streams[s].format == 'hls'
            || streams[s].format == 'multitrack_adaptive_hls_v2' ? true : false;
        let checkParams = isHls && streams[s].hardsub_lang === null;
        if(streams[s].url.match(/clipFrom/)){
            isClip = true;
        }
        if(checkParams && !isClip){
            hlsStream = streams[s].url;
            console.log(`[INFO] Full raw stream found!`);
        }
    }
    
    // download stream
    if(hlsStream == '' && !isClip){
        console.log(`[ERROR] No available full raw stream! Session expired?`);
        argv.skipmux = true;
    }
    else if(hlsStream == '' && isClip){
        console.log(`[ERROR] No available full raw stream! Only clip streams available.`);
        argv.skipmux = true;
    }
    else{
        // get
        console.log(`[INFO] Downloading video...`);
        let streamPlaylist = await getData(hlsStream);
        if(!streamPlaylist.ok){
            console.log(`[ERROR] CAN'T FETCH VIDEO PLAYLISTS!`);
            return;
        }
        // parse
        let plQualityLinkList = m3u8(streamPlaylist.res.body);
        // main servers
        let mainServersList = [
            'v.vrv.co',
            'a-vrv.akamaized.net'
        ];
        // variables
        let plServerList = [],
            plStreams    = {},
            plQualityStr = [],
            plMaxQuality = 240;
        // set variables
        for(let s of plQualityLinkList.playlists){
            let plResolution = s.attributes.RESOLUTION.height;
            let plResText    = `${plResolution}p`;
            plMaxQuality = plMaxQuality < plResolution ? plResolution : plMaxQuality;
            let plUrlDl  = s.uri;
            let plServer = plUrlDl.split('/')[2];
            if(!plServerList.includes(plServer)){
                plServerList.push(plServer);
            }
            if(!Object.keys(plStreams).includes(plServer)){
                plStreams[plServer] = {};
            }
            if(plStreams[plServer][plResText] && plStreams[plServer][plResText] != plUrlDl){
                console.log(`[WARN] Non duplicate url for ${plServer} detected, please report to developer!`);
            }
            else{
                plStreams[plServer][plResText] = plUrlDl;
            }
            // set plQualityStr
            let plBandwidth  = Math.round(s.attributes.BANDWIDTH/1024);
            if(plResolution<1000){
                plResolution = plResolution.toString().padStart(4,' ');
            }
            let qualityStrAdd   = `${plResolution}p (${plBandwidth}KiB/s)`;
            let qualityStrRegx  = new RegExp(qualityStrAdd.replace(/(\:|\(|\)|\/)/g,'\\$1'),'m');
            let qualityStrMatch = !plQualityStr.join('\r\n').match(qualityStrRegx);
            if(qualityStrMatch){
                plQualityStr.push(qualityStrAdd);
            }
        }
        
        for(let s of mainServersList){
            if(plServerList.includes(s)){
                plServerList.splice(plServerList.indexOf(s),1);
                plServerList.unshift(s);
                break;
            }
        }
        
        argv.q = argv.q == 'max' ? `${plMaxQuality}p` : argv.q;
        
        let plSelectedServer = plServerList[argv.x-1];
        let plSelectedList   = plStreams[plSelectedServer];
        let videoUrl = argv.x < plServerList.length+1 && plSelectedList[argv.q] ? plSelectedList[argv.q] : '';
        
        plQualityStr.sort();
        console.log(`[INFO] Servers available:\n\t${plServerList.join('\n\t')}`);
        console.log(`[INFO] Available qualities:\n\t${plQualityStr.join('\n\t')}`);
        
        if(videoUrl != ''){
            console.log(`[INFO] Selected quality: ${argv.q} @ ${plSelectedServer}`);
            console.log(`[INFO] Stream URL:`,videoUrl);
            // filename
            fnSuffix = argv.suffix.replace('SIZEp',argv.q);
            fnOutput = shlp.cleanupFilename(`[${argv.a}] ${fnTitle} - ${fnEpNum} [${fnSuffix}]`);
            console.log(`[INFO] Output filename: ${fnOutput}`);
            if(argv.skipdl){
                console.log(`[INFO] Video download skipped!\n`);
            }
            else{
                // request
                let chunkPage = await getData(videoUrl);
                if(!chunkPage.ok){
                    console.log(`[ERROR] CAN'T FETCH VIDEO PLAYLIST!`);
                    argv.skipmux = true;
                }
                else{
                    let chunkList = m3u8(chunkPage.res.body);
                    chunkList.baseUrl = videoUrl.split('/').slice(0, -1).join('/')+'/';
                    // proxy
                    let proxyHLS;
                    if(argv.proxy && !argv.ssp){
                        try{
                            proxyHLS.url = buildProxyUrl(argv.proxy,argv['proxy-auth']);
                        }
                        catch(e){}
                    }
                    let dldata = await streamdl({
                        fn: fnOutput,
                        m3u8json: chunkList,
                        baseurl: chunkList.baseUrl,
                        pcount: 10,
                        proxy: (proxyHLS?proxyHLS:false)
                    });
                    if(!dldata.ok){
                        console.log(`[ERROR] ${dldata.error}\n`);
                        argv.skipmux = true;
                    }
                }
            }
        }
        else if(argv.x > plServerList.length){
            console.log(`[ERROR] Server not selected!\n`);
            argv.skipmux = true;
        }
        else{
            console.log(`[ERROR] Quality not selected!\n`);
            argv.skipmux = true;
        }
    }
    
    // always get old subs
    getOldSubs = argv.oldsubs;
    
    // download subs
    sxList = [];
    if(!argv.skipsubs || argv.dlsubs != 'none'){
        console.log(`[INFO] Downloading subtitles...`);
        if(!getOldSubs && mediaData.subtitles.length < 1){
            console.log(`[WARN] Can't find urls for subtitles! If you downloading sub version, try use oldsubs cli option`);
        }
        if(getOldSubs){
            let mediaIdSubs = mMeta.m;
            console.log(`[INFO] Trying get subtitles in old format...`);
            if(hlsStream == ''){
                let reqParams = new URLSearchParams({
                    req:          'RpcApiVideoPlayer_GetStandardConfig',
                    media_id:      mMeta.m,
                    video_format:  106,
                    video_quality: 61,
                    aff:           'crunchyroll-website',
                    current_page:  domain
                });
                let streamData = await getData(`${domain}/xml/?${reqParams.toString()}`);
                if(!streamData.ok){
                    console.log(streamData);
                    mediaIdSubs = '0';
                }
                else{
                    let mediaMetadataXml = xhtml2js({ src: streamData.res.body, el: 'media_metadata', isXml: true }).$;
                    mediaIdSubs = mediaMetadataXml.find('media_id').text();
                }
            }
            if(parseInt(mediaIdSubs)>0){
                let subsListApi = await getData(`${api.subs_list}${mediaIdSubs}`);
                if(subsListApi.ok){
                    // parse list
                    let subsListXml = xhtml2js({
                        src: subsListApi.res.body,
                        el: 'subtitles',
                        isXml: true,
                        parse: true,
                    }).data.children;
                    // subsDecrypt
                    for(let s=0;s<subsListXml.length;s++){
                        if(subsListXml[s].tagName=='subtitle'){
                            let subsId = subsListXml[s].attribs.id;
                            let subsTt = subsListXml[s].attribs.title;
                            let subsXmlApi = await getData(`${api.subs_file}${subsId}`);
                            if(subsXmlApi.ok){
                                let subXml      = crunchySubs.decrypt(subsListXml[s].attribs.id,subsXmlApi.res.body);
                                if(subXml.ok){
                                    let subsParsed  = crunchySubs.parse(subsListXml[s].attribs,subXml.data);
                                    let sLang = subsParsed.langCode.match(/(\w{2}) - (\w{2})/);
                                    sLang = `${sLang[1]}${sLang[2].toUpperCase()}`;
                                    subsParsed.langStr  = langCodes[subsParsed.langCode][1];
                                    subsParsed.langCode = langCodes[subsParsed.langCode][0];
                                    let subsExtFile = [
                                        subsParsed.id,
                                        subsParsed.langCode,
                                        subsParsed.langStr
                                    ].join(' ');
                                    subsParsed.file = `${fnOutput}.${subsExtFile}.ass`;
                                    if(argv.dlsubs == 'all' || argv.dlsubs == sLang){
                                        fs.writeFileSync(subsParsed.file,subsParsed.src);
                                        delete subsParsed.src;
                                        console.log(`[INFO] Downloaded: ${subsParsed.file}`);
                                        sxList.push(subsParsed);
                                    }
                                    else{
                                        console.log(`[INFO] Download skipped: ${subsParsed.file}`);
                                    }
                                }
                            }
                            else{
                                console.log(`[WARN] Failed to download subtitles #${subsId} ${subsTt}`);
                            }
                        }
                    }
                }
                else{
                    console.log(`[WARN] Failed to get subtitles list using old api!`);
                }
            }
            else{
                console.log(`[ERROR] Can't get video id for subtitles list!`);
            }
        }
        else if(mediaData.subtitles.length > 0){
            for( s of mediaData.subtitles ){
                let subsAssApi = await getData(s.url);
                let subsParsed = {};
                subsParsed.id = s.url.match(/_(\d+)\.txt\?/)[1];
                subsParsed.fonts = fontsData.assFonts(subsAssApi.res.body);
                subsParsed.langCode = s.language.match(/(\w{2})(\w{2})/);
                subsParsed.langCode = `${subsParsed.langCode[1]} - ${subsParsed.langCode[2]}`.toLowerCase();
                subsParsed.langStr  = langCodes[subsParsed.langCode][1];
                subsParsed.langCode = langCodes[subsParsed.langCode][0];
                let subsExtFile = [
                    subsParsed.id,
                    subsParsed.langCode,
                    subsParsed.langStr
                ].join(' ');
                subsParsed.file = `${fnOutput}.${subsExtFile}.ass`;
                if(argv.dlsubs == 'all' || argv.dlsubs == s.language){
                    if(subsAssApi.ok){
                        subsParsed.title = subsAssApi.res.body.split('\r\n')[1].replace(/^Title: /,'');
                        fs.writeFileSync(subsParsed.file, subsAssApi.res.body);
                        console.log(`[INFO] Downloaded: ${subsParsed.file}`);
                        sxList.push(subsParsed);
                    }
                    else{
                        console.log(`[WARN] Downloaded failed: ${subsParsed.file}`);
                    }
                }
                else{
                    console.log(`[INFO] Downloaded skipped: ${subsParsed.file}`);
                }
            }
        }
    }
    
    // go to muxing
    if(argv.skipmux){
        console.log();
        return;
    }
    await muxStreams();
    
}

async function muxStreams(){
    // skip if no ts
    if(!isFile(`${fnOutput}.ts`)){
        console.log(`[INFO] TS file not found, skip muxing video...\n`);
        return;
    }
    // fix variables
    let audioDub = audDubT != '' ? audDubT:
            (audDubE != '' ? audDubE : argv.dub);
    const addSubs = argv.mks && sxList.length > 0 ? true : false;
    // ftag
    argv.ftag = argv.ftag ? argv.ftag : argv.a;
    argv.ftag = shlp.cleanupFilename(argv.ftag);
    // check exec
    if( !argv.mp4 && !isFile(cfg.bin.mkvmerge) && !isFile(cfg.bin.mkvmerge+`.exe`) ){
        console.log(`[WARN] MKVMerge not found, skip using this...`);
        cfg.bin.mkvmerge = false;
    }
    if( !isFile(cfg.bin.ffmpeg) && !isFile(cfg.bin.ffmpeg+`.exe`) ){
        console.log((cfg.bin.mkvmerge?`\n`:``)+`[WARN] FFmpeg not found, skip using this...`);
        cfg.bin.ffmpeg = false;
    }
    // collect fonts info
    let fontsList = [];
    for(let s of sxList){
        fontsList = fontsList.concat(s.fonts);
    }
    fontsList = [...new Set(fontsList)];
    console.log(`\n[INFO] Required fonts:`,fontsList.join(', '));
    // mux to mkv
    if(!argv.mp4 && cfg.bin.mkvmerge){
        let mkvmux  = [];
        // defaults
        mkvmux.push(`--output`,`${fnOutput}.mkv`);
        mkvmux.push(`--disable-track-statistics-tags`,`--engage`,`no_variable_data`);
        // video
        mkvmux.push(`--track-name`,`0:[${argv.ftag}`);
        mkvmux.push(`--language`,`1:${audioDub}`);
        mkvmux.push(`--video-tracks`,`0`,`--audio-tracks`,`1`);
        mkvmux.push(`--no-subtitles`,`--no-attachments`);
        mkvmux.push(`${fnOutput}.ts`);
        // subtitles
        if(addSubs){
            for(let t of sxList){
                mkvmux.push(`--track-name`,`0:${t.langStr} / ${t.title}`);
                mkvmux.push(`--language`,`0:${t.langCode}`);
                mkvmux.push(`${t.file}`);
            }
        }
        if(addSubs){
            for(let f of fontsList){
                let fontFile = fontsData.fonts[f];
                if(fontFile){
                    let fontLoc  = path.join(cfg.dir.fonts, fontFile);
                    if(fs.existsSync(fontLoc) && fs.statSync(fontLoc).size != 0){
                        mkvmux.push(`--attachment-name`,fontFile);
                        mkvmux.push(`--attach-file`,fontLoc);
                    }
                }
            }
        }
        fs.writeFileSync(`${fnOutput}.json`,JSON.stringify(mkvmux,null,'  '));
        shlp.exec(`mkvmerge`,`"${cfg.bin.mkvmerge}"`,`@"${fnOutput}.json"`);
        fs.unlinkSync(fnOutput+`.json`);
    }
    else if(cfg.bin.ffmpeg){
        let ffmux  = [], ffext = !argv.mp4 ? `mkv` : `mp4`;
            ffsubs = addSubs ? true : false; // && !argv.mp4
        let ffmap = [], ffmeta = [];
        ffmux.push(`-i`,`"${fnOutput}.ts"`);
        if(ffsubs){
            let ti = 0;
            for(let t of sxList){
                ffmux.push(`-i`,`"${t.file}"`);
                ffmap.push(`-map ${ti+1}`,`-c:s`,(!argv.mp4?`copy`:`mov_text`));
                ffmeta.push(`-metadata:s:s:${ti}`,`language=${t.langCode}`);
                ffmeta.push(`-metadata:s:s:${ti}`,`title="${t.langStr} / ${t.title}"`);
                ti++;
            }
        }
        ffmux.push(`-map 0:0 -c:v copy`);
        ffmux.push(`-map 0:1 -c:a copy`);
        ffmux = ffmux.concat(ffmap);
        if(ffsubs && ffext == 'mkv'){
            let attIndex = 0;
            for(let f of fontsList){
                let fontFile = fontsData.fonts[f];
                if(fontFile){
                    let fontLoc  = path.join(cfg.dir.fonts, fontFile);
                    let fontMime = fontsData.fontMime(fontFile);
                    if(fs.existsSync(fontLoc) && fs.statSync(fontLoc).size != 0){
                        ffmux.push(`-attach`,`"${fontLoc}"`);
                        ffmeta.push(`-metadata:s:t:${attIndex}`,`mimetype="${fontMime}"`);
                        ffmeta.push(`-metadata:s:t:${attIndex}`,`filename="${fontFile}"`);
                        attIndex++;
                    }
                }
            }
        }
        ffmux.push(`-metadata`,`encoding_tool="no_variable_data"`);
        ffmux.push(`-metadata:s:v:0`,`title="[${argv.ftag.replace(/"/g,"'")}]"`);
        ffmux.push(`-metadata:s:a:0`,`language=${audioDub}`);
        ffmux = ffmux.concat(ffmeta);
        ffmux.push(`"${fnOutput}.${ffext}"`);
        try{ shlp.exec(`ffmpeg`,`"${cfg.bin.ffmpeg}"`,ffmux.join(' ')); }catch(e){}
    }
    else{
        console.log(`\n[INFO] Done!\n`);
        return;
    }
    if(argv.nocleanup){
        fs.renameSync(fnOutput+`.ts`, path.join(cfg.dir.trash,`/${fnOutput}.ts`));
        if(addSubs){
            for(let t in sxList){
                fs.renameSync(sxList[t].file, path.join(cfg.dir.trash,`/${sxList[t].file}`));
            }
        }
    }
    else{
        fs.unlinkSync(fnOutput+`.ts`);
        if(addSubs){
            for(let t in sxList){
                fs.unlinkSync(sxList[t].file);
            }
        }
    }
    console.log(`\n[INFO] Done!\n`);
}

function isFile(file){
    try{
        const isFile = fs.statSync(file).isFile();
        return isFile;
    }
    catch(e){
        return false;
    }
}

// get url
async function getData(durl, params){
    params = params || {};
    // options
    let options = {
        method: params.method ? params.method : 'GET',
        headers: {},
        url: durl
    };
    // set binary
    if(params.binary == true){
        options.encoding = null;
    }
    // set headers
    if(params.headers){
        options.headers = params.headers;
    }
    // set additional headers
    if(options.method == 'POST'){
        options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    // set body
    if(params.body){
        options.body = params.body;
    }
    // proxy
    if(params.useProxy && argv.proxy){
        try{
            let proxyUrl = buildProxyUrl(argv.proxy,argv['proxy-auth']);
            options.agent = new agent(proxyUrl);
            options.timeout = 10000;
        }
        catch(e){
            console.log(`\n[WARN] Not valid proxy URL${e.input?' ('+e.input+')':''}!`);
            console.log(`[WARN] Skiping...`);
        }
    }
    // if auth
    let cookie = [];
    if(checkCookieVal(session.c_userid) && checkCookieVal(session.c_userkey)){
        cookie.push('c_userid', 'c_userkey');
    }
    if(checkSessId(session.session_id) && !argv.nosess){
        cookie.push('session_id');
    }
    if(!params.skipCookies){
        cookie.push('c_locale');
        options.headers.Cookie =
            shlp.cookie.make(Object.assign({c_locale:{value:'enUS'}},session),cookie);
    }
    try {
        let res = await got(options);
        if(!params.skipCookies && res.headers['set-cookie']){
            setNewCookie(res.headers['set-cookie']);
        }
        return {
            ok: true,
            res,
        };
    }
    catch(error){
        if(error.statusCode && error.statusMessage){
            console.log(`[ERROR] ${error.name} ${error.statusCode}: ${error.statusMessage}`);
        }
        else{
            console.log(`[ERROR] ${error.name}: ${error.code}`);
        }
        return {
            ok: false,
            error,
        };
    }
}
function setNewCookie(setCookie, isAuth){
    let cookieUpdated = [];
    setCookie = shlp.cookie.parse(setCookie);
    if(isAuth || setCookie.c_userid){
        session.c_userid = setCookie.c_userid;
        cookieUpdated.push('c_userid');
    }
    if(isAuth || setCookie.c_userkey){
        session.c_userkey = setCookie.c_userkey;
        cookieUpdated.push('c_userkey');
    }
    if(isAuth || argv.nosess && setCookie.session_id || setCookie.session_id && !checkSessId(session.session_id)){
        const sessionExp = 60*60;
        session.session_id            = setCookie.session_id;
        session.session_id.expires    = new Date(Date.now() + sessionExp*1000);
        session.session_id['Max-Age'] = sessionExp.toString();
        cookieUpdated.push('session_id');
    }
    if(cookieUpdated.length > 0){
        session = yaml.stringify(session);
        fs.writeFileSync(sessionFile,session);
        session = yaml.parse(session);
        console.log(`[INFO] Cookies were updated! (${cookieUpdated.join(', ')})\n`);
    }
}
function checkCookieVal(chcookie){
    return     chcookie
            && chcookie.toString()   == "[object Object]"
            && typeof chcookie.value == "string"
            ?  true : false;
}
function checkSessId(session_id){
    return     session_id
            && session_id.toString()     == "[object Object]"
            && typeof session_id.expires == "string"
            && Date.now() < new Date(session_id.expires).getTime()
            && typeof session_id.value   == "string"
            ?  true : false;
}
function buildProxyUrl(proxyBaseUrl,proxyAuth){
    let proxyCfg = new URL(proxyBaseUrl);
    if(typeof proxyCfg.hostname != 'string' || typeof proxyCfg.port != 'string'){
        throw new Error();
    }
    if(proxyAuth && typeof proxyAuth == 'string' && proxyAuth.match(':')){
        proxyCfg.auth = proxyAuth;
    }
    return url.format({
        protocol: proxyCfg.protocol,
        slashes: true,
        auth: proxyCfg.auth,
        hostname: proxyCfg.hostname,
        port: proxyCfg.port,
    });
}
