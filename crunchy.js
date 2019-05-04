#!/usr/bin/env node

// build-in
const path = require('path');
const fs = require('fs');
const qs = require('querystring');

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

// qualities
const qualities = {
    // type : format, quality
    '240p':  [102,20],
    '360p':  [106,60],
    '480p':  [106,61],
    '720p':  [106,62],
    '1080p': [108,80],
    'max':   [108,80]
};

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
    'Japanese':   'jpn',
    '':           'unk',
};
const isoLangs = [];
for(let lk of Object.keys(dubLangs)){
    isoLangs.push(dubLangs[lk]);
}
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
    '':        ['unk','Unknown']
};
// dubRegex
const dubRegex = 
    new RegExp(`\\((${Object.keys(dubLangs).join('|')}) Dub\\)$`);

// args
let argv = yargs
    // main
    .wrap(Math.min(100))
    .usage('Usage: $0 [options]')
    .help(false).version(false)
    
    // search
    .describe('search','Search show ids')
    
    // auth
    .describe('auth','Enter auth mode')
    
    .describe('s','Sets the show id')
    .describe('e','Select episode ids (comma-separated, hyphen-sequence)')
    
    // quality
    .describe('q','Video Quality')
    .choices('q', Object.keys(qualities))
    .default('q',cfg.cli.videoQuality)
    
    // set dub
    .describe('dub','Set audio language (sometimes not detect correctly)')
    .choices('dub', [...new Set(isoLangs)])
    .default('dub', cfg.cli.dubLanguage)
    
    // server
    .describe('x','Select server (1 is vrv.co, 2...3 is dlvr1.net)')
    .choices('x', [1, 2, 3])
    .default('x', cfg.cli.nServer)
    
    // oldsubs api
    .describe('oldsubs','Use old api for fetching subtitles')
    .boolean('oldsubs')
    .default('oldsubs', cfg.cli.oldSubs)
    
    // muxing
    .describe('mp4','Mux into mp4')
    .boolean('mp4')
    .default('mp4',cfg.cli.mp4mux)
    .describe('mks','Add subtitles to mkv (if available)')
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
const domain = 'https://www.crunchyroll.com';
const api = {
    search:      `${domain}/ajax/?req=RpcApiSearch_GetSearchCandidates`,
    search2:     `${domain}/search_page`,
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
else if(argv.search && argv.search.length > 2){
    doSearch();
}
else if(argv.s && !isNaN(parseInt(argv.s,10)) && parseInt(argv.s,10) > 0){
    getShowById();
}
else{
    yargs.showHelp();
    process.exit();
}

// auth
async function doAuth(){
    console.log(`[INFO] Authentication`);
    const iLogin = await shlp.question(`[Q] LOGIN/EMAIL`);
    const iPsswd = await shlp.question(`[Q] PASSWORD   `);
    const authData = qs.stringify({
        name: iLogin,
        password: iPsswd
    });
    let auth = await getData(api.auth,{ method: 'POST', body: authData, useProxy: true, skipCookies: true });
    if(!auth.ok){
        console.log(`[ERROR] Authentication failed!`);
        return;
    }
    setNewCookie(auth.res.headers['set-cookie'], true);
    console.log(`[INFO] Authentication successful!`);
}

async function doSearch(){
    // seacrh params
    const params = {
        q: argv.search,
        sp: argv.p ? parseInt(argv.p) - 1 : 0,
        st: 'm'
    };
    // request
    let reqAniList = await getData(`${api.search2}?${qs.stringify(params)}`);
    if(!reqAniList.ok){ return; }
    // parse fix
    let aniListSec = reqAniList.res.body.replace(/^\/\*-secure-\n(.*)\n\*\/$/,'$1');
    aniListSec = JSON.parse(aniListSec);
    let totalResults = 0;
    // data
    const mainHtml = xhtml2js({ src: '<html>'+aniListSec.data.main_html+'</html>', el: 'body' }).$;
    const results0 = mainHtml.find('p');
    const results1 = results0.eq(0).text().trim();
    const results2 = results0.eq(1).text().trim();
    const resultsStr = results2 != '' ? results2 : 
        results1 != '' ? results1 : 'NOTHING FOUND!';
    console.log(`[INFO] ${resultsStr}`);
    // seasons
    const searchData = mainHtml.find('li');
    for(let v=0;v<searchData.length;v++){
        let href = searchData.eq(v).find('a')[0].attribs.href;
        let name = searchData.eq(v).find('.name');
        let libn = name[0].children[0].data.trim();
        let type = name[0].children[1].children[0].data.trim().replace(/(\(|\))/g,'');
        let isLib = href.match(/^\/library\//) ? true : false;
        if(type == 'Series' && !isLib){
            console.log(`[${type}] ${libn}`);
            await getShowByUri(href, libn);
            totalResults++;
        }
    }
    console.log(`\n[INFO] Some non-video results is hidden\n       RL: Region LOCK`);
    if(totalResults>0){
        console.log(`[INFO] Total results: ${totalResults}\n`);
    }
}

async function getShowByUri(uri, title){
    uri = uri.replace(/^\//,'');
    let vList = await getData(`${domain}/${uri}/videos`,{ "headers": { "X-Requested-With": "XMLHttpRequest"} });
    if(!vList.ok){ return; }
    let sTitle = '', items,
        src = `<body>${vList.res.body}</body>`;
    items = xhtml2js({ src, el: 'ul.list-of-seasons', parse: true }).data;
    if(!items){
        console.log(`  [ERROR] Removed from CR catalog!`);
        return; 
    }
    else{
        items = items.children
    }
    for(let i of items){
        let c = i.children;
        let t = c[0].tagName;
        let e = t == 'a' ? 1 : 0;
        let s = -1;
        if(e > 0){
            sTitle = c[0].attribs.title;
        }
        else{
            sTitle = title ? title : uri;
        }
        if(c[e].children.length>1){
            let xEp = c[e].children[0].attribs.id.match(/(\d+)/)[1];
            s = await fetchShowIdFromVideoPage(xEp);
        }
        console.log(`  [S:${s>-1?s:'RL'}] ${sTitle}`);
    }
    
}

async function fetchShowIdFromVideoPage(xEp){
    uEx = `${domain}/media-${xEp}`;
    let vPage = await getData(uEx);
    if(!vPage.ok){ return 0; }
    let coll_id = vPage.res.body.match(/collection_id: "(\d+)"/);
    coll_id = coll_id ? coll_id[1] : 0;
    return coll_id;
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
        console.log(`[ERROR] CAN'T FETCH VIDEO INFO / PREMIUM LOCKED FOR YOUR REGION`);
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
        let checkParams = streams[s].format == 'hls'
            && streams[s].hardsub_lang === null;
        if(streams[s].url.match(/clipFrom/)){
            isClip = true;
        }
        if(checkParams && !isClip){
            hlsStream = streams[s].url;
        }
    }
    
    // download stream
    if(hlsStream == ''){
        console.log(`[ERROR] No available full streams!`);
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
        // contain
        let plQuality = {};
        let plQualityAlt = {};
        let plQualityStr = [];
        let pl_max = 0;
        // check
        for(let s of plQualityLinkList.playlists){
            let pl_quality = s.attributes.RESOLUTION.height;
            pl_max = pl_max < pl_quality ? pl_quality : pl_max;
            let pl_BANDWIDTH = Math.round(s.attributes.BANDWIDTH/1024);
            let pl_url = s.uri;
            let dl_domain = pl_url.split('/')[2];
            if(typeof plQualityAlt[`${pl_quality}p`] == 'undefined'){
                plQualityAlt[`${pl_quality}p`] = [];
            }
            let qualityStrAdd   = `${pl_quality}p (${pl_BANDWIDTH}KiB/s)`;
            let qualityStrRegx  = new RegExp(qualityStrAdd.replace(/(\(|\)|\/)/g,'\\$1'),'m');
            let qualityStrMatch = !plQualityStr.join('\r\n').match(qualityStrRegx);
            if(dl_domain.match(/.vrv.co$/)){
                if(qualityStrMatch){
                    plQualityStr.push(qualityStrAdd);
                }
                plQuality[`${pl_quality}p`] = { "url": pl_url };
            }
            else{
                if(qualityStrMatch){
                    plQualityStr.push(qualityStrAdd);
                }
                plQualityAlt[`${pl_quality}p`].push({ "url": pl_url });
            }
        }
        argv.x = argv.x - 1;
        argv.q = argv.q == 'max' || parseInt(argv.q.replace(/p/,'')) > pl_max ? `${pl_max}p` : argv.q;
        let maxServers = plQualityAlt[argv.q].length + 1;
        if( !plQuality[argv.q] && plQualityAlt[argv.q][0] ){
            plQuality[argv.q].url = plQualityAlt[argv.q][0].url;
        }
        if(argv.x > 0){
            plQuality[argv.q] = argv.x > maxServers-1 ? plQualityAlt[argv.q][0] : plQualityAlt[argv.q][argv.x-1];
        }
        if(plQuality[argv.q]){
            // show qualities
            console.log(`[INFO] Selected quality: ${argv.q}\n\tAvailable qualities:\n\t\t${plQualityStr.join('\n\t\t')}`);
            // servers
            console.log(`[INFO] Selected server: ` + ( argv.x < 1 ? `1` :
                ( argv.x > maxServers-1 ? maxServers : argv.x+1 ) ) + ` / Total servers available: ` + maxServers );
            // video url
            let vidUrl = plQuality[argv.q].url;
            console.log(`[INFO] Stream URL:`,vidUrl);
            // filename
            fnSuffix = argv.suffix.replace('SIZEp',argv.q);
            fnOutput = shlp.cleanupFilename(`[${argv.a}] ${fnTitle} - ${fnEpNum} [${fnSuffix}]`);
            console.log(`[INFO] Output filename: ${fnOutput}`);
            if(argv.skipdl){
                console.log(`[INFO] Video download skiped!\n`);
            }
            else{
                // request
                let chunkPage = await getData(vidUrl);
                if(!chunkPage.ok){
                    console.log(`[ERROR] CAN'T FETCH VIDEO PLAYLIST!`);
                    return;
                }
                let chunkList = m3u8(chunkPage.res.body);
                chunkList.baseUrl = vidUrl.split('/').slice(0, -1).join('/')+'/';
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
                    console.log(`[ERROR] ${dldata.err}\n`);
                    return;
                }
            }
        }
        else{
            console.log(`[INFO] Available qualities:`,plQualityStr.join('\n\t'));
            console.log(`[ERROR] quality not selected\n`);
            argv.skipdl = true;
        }
    }
    
    // always get old subs
    getOldSubs = argv.oldsubs;
    
    // download subs
    sxList = [];
    if(!argv.skipsubs){
        console.log(`[INFO] Downloading subtitles...`);
        if(!getOldSubs && mediaData.subtitles.length < 1){
            console.log(`[WARN] Can't find urls for subtitles! If you downloading sub version, try use oldsubs cli option`);
        }
        if(getOldSubs){
            let mediaIdSubs = mMeta.m;
            console.log(`[INFO] Trying get subtitles in old format...`);
            if(hlsStream == ''){
                let reqParams = {
                    req: 'RpcApiVideoPlayer_GetStandardConfig',
                    media_id: mMeta.m,
                    video_format: qualities['480p'][0],
                    video_quality: qualities['480p'][1],
                    aff: 'crunchyroll-website',
                    current_page: domain
                };
                let streamData = await getData(`${domain}/xml/`,{"qs":reqParams});
                if(!streamData.ok){
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
                        parse:true 
                    }).data.children;
                    // subsDecrypt
                    for(let s=0;s<subsListXml.length;s++){
                        if(subsListXml[s].tagName=='subtitle'){
                            let subsId = subsListXml[s].attribs.id;
                            let subsXmlApi = await getData(`${api.subs_file}${subsId}`);
                            if(subsXmlApi.ok){
                                let subXml      = crunchySubs.decrypt(subsListXml[s].attribs.id,subsXmlApi.res.body);
                                if(subXml.ok){
                                    let subsParsed  = crunchySubs.parse(subsListXml[s].attribs,subXml.data);
                                    let subsExtFile = [
                                        subsParsed.id,
                                        langCodes[subsParsed.langCode][0],
                                        langCodes[subsParsed.langCode][1]
                                    ].join(' ');
                                    let subsFile = `${fnOutput}.${subsExtFile}.ass`;
                                    fs.writeFileSync(subsFile,subsParsed.src);
                                    console.log(`[INFO] Downloaded: ${subsFile}`);
                                    sxList.push({
                                        id: subsParsed.id,
                                        langCode: langCodes[subsParsed.langCode][0],
                                        langStr: langCodes[subsParsed.langCode][1],
                                        title: subsParsed.title,
                                        file: subsFile,
                                        // isDefault: subsParsed.isDefault,
                                    });
                                }
                            }
                        }
                    }
                }
                if(sxList.length>0){
                    // console.log(yaml.stringify(sxList));
                }
            }
            else{
                console.log(`[ERR] Can't get video id for subtitles list!`);
            }
        }
        else if(mediaData.subtitles.length > 0){
            for( s of mediaData.subtitles ){
                let subsAssApi = await getData(s.url);
                if(subsAssApi.ok){
                    let subsParsed = {};
                    subsParsed.id = s.url.match(/_(\d+)\.txt\?/)[1];
                    subsParsed.langCode = s.language.match(/(\w{2})(\w{2})/);
                    subsParsed.langCode = `${subsParsed.langCode[1]} - ${subsParsed.langCode[2]}`.toLowerCase();
                    subsParsed.langStr  = langCodes[subsParsed.langCode][1];
                    subsParsed.langCode = langCodes[subsParsed.langCode][0];
                    subsParsed.title    = subsAssApi.res.body.split('\r\n')[1].replace(/^Title: /,'');
                    let subsExtFile = [
                        subsParsed.id,
                        subsParsed.langCode,
                        subsParsed.langStr
                    ].join(' ');
                    let subsFile = `${fnOutput}.${subsExtFile}.ass`;
                    fs.writeFileSync(subsFile,subsAssApi.res.body);
                    console.log(`[INFO] Downloaded: ${subsFile}`);
                    subsParsed.file = subsFile;
                    sxList.push(subsParsed);
                }
            }
            if(sxList.length>0){
                // console.log(yaml.stringify(sxList));
            }
        }
    }
    
    if(hlsStream != ''){
        // go to muxing
        if(argv.skipmux){
            console.log();
            return;
        }
        await muxStreams();
    }
    
}

async function muxStreams(){
    // fix variables
    let audioDub = audDubT != '' ? audDubT:
            (audDubE != '' ? audDubE : argv.dub);
    const addSubs = argv.mks && sxList.length > 0 && !argv.mp4 ? true : false;
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
    // mux to mkv
    if(!argv.mp4 && cfg.bin.mkvmerge){
        let mkvmux  = [];
        // defaults
        mkvmux.push(`--output`,`${fnOutput}.mkv`);
        mkvmux.push(`--disable-track-statistics-tags`,`--engage`,`no_variable_data`);
        // video
        mkvmux.push(`--track-name`,`0:[${argv.ftag}]`);
        mkvmux.push(`--language`,`1:${audioDub}`);
        mkvmux.push(`--video-tracks`,`0`,`--audio-tracks`,`1`);
        mkvmux.push(`--no-subtitles`,`--no-attachments`);
        mkvmux.push(`${fnOutput}.ts`);
        // subtitles
        if(addSubs){
            for(let t in sxList){
                mkvmux.push(`--track-name`,`0:${sxList[t].langStr} / ${sxList[t].title}`);
                mkvmux.push(`--language`,`0:${sxList[t].langCode}`);
                mkvmux.push(`--default-track`,`0:no`);
                mkvmux.push(`${sxList[t].file}`);
            }
        }
        fs.writeFileSync(`${fnOutput}.json`,JSON.stringify(mkvmux,null,'  '));
        shlp.exec(`mkvmerge`,`"${cfg.bin.mkvmerge}"`,`@"${fnOutput}.json"`);
        fs.unlinkSync(fnOutput+`.json`);
    }
    else if(argv.mp4 && cfg.bin.ffmpeg){
        let ffmux = `-i "${fnOutput}.ts" `;
            ffmux += `-map 0 -c:v copy -c:a copy `;
            ffmux += `-metadata encoding_tool="no_variable_data" `;
            ffmux += `-metadata:s:v:0 title="[${argv.ftag}]" -metadata:s:a:0 language=${audioDub} `;
            ffmux += `"${fnOutput}.mp4"`;
        // mux to mkv
        try{ shlp.exec(`ffmpeg`,`"${cfg.bin.ffmpeg}"`,ffmux); }catch(e){}
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
    if(typeof session.c_userid != "undefined" && typeof session.c_userkey != "undefined"){
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
        session.session_id = setCookie.c_userid;
        cookieUpdated.push('c_userkey');
    }
    if(isAuth || argv.nosess || setCookie.session_id && !checkSessId(session.session_id)){
        const sessionExp = 60*60;
        session.session_id            = setCookie.session_id;
        session.session_id.expires    = new Date(Date.now() + sessionExp*1000);
        session.session_id['Max-Age'] = sessionExp.toString();
        cookieUpdated.push('session_id');
    }
    if(cookieUpdated.length > 0){
        fs.writeFileSync(sessionFile,yaml.stringify(session));
        console.log(`[INFO] Cookies was updated! (${cookieUpdated.join(',')})\n`);
    }
}
function checkSessId(session_id){
    return     typeof session_id         != "undefined"
            && typeof session_id.expires != "undefined"
            && Date.now() < new Date(session_id.expires).getTime()
            ?  true : false;
}
function buildProxyUrl(proxyBaseUrl,proxyAuth){
    let proxyCfg = new URL(proxyBaseUrl);
    if(!proxyCfg.hostname || !proxyCfg.port){
        throw new Error();
    }
    if(proxyAuth && proxyAuth.match(':')){
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
