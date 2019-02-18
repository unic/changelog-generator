const argv = require('minimist')(process.argv.slice(2));
const util = require('util');
const fs = require('fs');
const path = require('path');
const rimraf = util.promisify(require('rimraf'));
const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);
const renderFile = util.promisify(require('twig').renderFile);
const stripAnsi = require('strip-ansi');
const AnsiToHtmlConverter = require('ansi-to-html');
const spawn = require('child_process').spawn;
const exec = util.promisify(require('child_process').exec);

const repository = argv._[0];
const oldTag = argv['old-tag'];
const newTag = argv['new-tag'];

const previewCommand = argv['preview-cmd'] ? argv['preview-cmd'] : false;
const previewFolder = argv['preview-folder'] ? argv['preview-folder'] : false;
const previewOnlineUrl = argv['preview-url'] ? argv['preview-url'].replace(/\/$/, '') : false;
const previewGenerate = argv['preview-generate'] ? argv['preview-generate'] === 'true' : true;

const ignoreFiles = argv['ignore-files'] ? argv['ignore-files']: '(.js|.css|index.html)$';
const cols = argv['cols'] ? argv['cols'] : '220';
const numlinesContext = argv['context'] ? argv['context'] : '7';

const ignoreFilesExp = ignoreFiles !== '' ? new RegExp(ignoreFiles, 'i') : null;
const repoPath = path.join(__dirname, 'repos');

const changelogInput = 'changelog.twig';
const changelogOutput = 'changelog.html';


const installTag = async function(tag) {
    return new Promise(async (resolve, reject) => {
        await exec(`git clone ${repository} ${tag}`, {
            cwd: repoPath
        });

        await exec(`git checkout ${tag}`, {
            cwd: path.join(repoPath, tag)
        });

        const child = spawn('npm', [
            'install'
        ], {
            cwd: path.join(repoPath, tag)
        });

        child.stderr.on('data', function(data) {
            console.log('stderr: ' + data);
            reject(data.toString());
        });

        child.on('close', function(code) {
            if (code !== 0) {
                console.log(`npm install process exited with code ${code}`);
                reject(code);
                return;
            }

            resolve(tag);
        });
    });
};

const installTags = async function() {
    return Promise.all([
        installTag(oldTag),
        installTag(newTag)
    ]);
};

const generateProjectPreview = async function(projectPath) {
    return new Promise((resolve, reject) => {
        const cmd = previewCommand.split(' ');
        const child = spawn(cmd.shift(), cmd, {
            cwd: projectPath
        });

        child.stderr.on('data', function(data) {
            console.log('stderr: ' + data);
            reject(data.toString());
        });

        child.on('close', function(code) {
            if (code !== 0) {
                console.log(`npm run preview process exited with code ${code}`);
                reject(code);
                return;
            }

            resolve();
        });
    })
};

const generatePreviews = async function() {
    return Promise.all([
        generateProjectPreview(path.join(repoPath, oldTag)),
        generateProjectPreview(path.join(repoPath, newTag))
    ]);
};

const diff = async function() {
    return new Promise((resolve, reject) => {
        const oldPreviewPath = path.join(repoPath, oldTag, previewFolder);
        const newPreviewPath = path.join(repoPath, newTag, previewFolder);

        const folders = {};
        
        const convert = new AnsiToHtmlConverter({
            fg: '#889797',
            bg: '#002630',
            newline: true,
            escapeXML: true
        });

        var child = spawn('icdiff', [
            `--cols=${cols}`,
            `--recursive`,
            `--numlines=${numlinesContext}`,
            `--line-numbers`,
            oldPreviewPath,
            newPreviewPath
        ]);

        let currentFileIgnore = false;
        let currentFilePath = null;
        let currentFileSection = 0;
        let currentSectionData = '';

        child.stdout.on('data', function(data) {
            const checkFile = /\u001b\[0;34m[^\[]*\[m/i;
            const checkFileNewOrMissing = /\u001b\[0;35m[^\[]*\[m/i;
            const string = data.toString();
            const matchFile = checkFile.exec(string);
            const matchFileNewOrMissing = checkFileNewOrMissing.exec(string);

            if (matchFile !== null) {
                const filePathRoot = stripAnsi(matchFile[0]);
                const newSection = filePathRoot === '---';

                if (currentSectionData !== '') {
                    // write previous section to current set file path
                    const fileFirstFolder = currentFilePath.split('/')[0];
                    folders[fileFirstFolder].sites[currentFilePath].sections[currentFileSection].html = convert.toHtml(currentSectionData);
                    currentSectionData = '';
                }

                if (newSection) {
                    if (!currentFileIgnore) {
                        const fileFirstFolder = currentFilePath.split('/')[0];
                        folders[fileFirstFolder].sites[currentFilePath].sections.push({
                            html: ''
                        });

                        currentFileSection = currentFileSection + 1;
                    }
                } else {
                    currentFileIgnore = false;

                    const filePath = filePathRoot.substring(oldPreviewPath.length + 1);
                    const fileFirstFolder = filePath.split('/')[0];

                    if (ignoreFilesExp && ignoreFilesExp.exec(filePath) !== null) {
                        currentFileIgnore = true;
                        return;
                    }

                    if (typeof folders[fileFirstFolder] === 'undefined') {
                        folders[fileFirstFolder] = {
                            sites: {},
                            missingOrNew: []
                        };
                    }

                    if (typeof folders[fileFirstFolder].sites[filePath] === 'undefined') {
                        folders[fileFirstFolder].sites[filePath] = {
                            sections: [
                                { html: '' }
                            ]
                        };
                    }

                    if (matchFileNewOrMissing !== null) {
                        const onlyText = stripAnsi(matchFileNewOrMissing[0]).replace(`${repoPath}/`, '');
                        folders[fileFirstFolder].missingOrNew.push(onlyText);
                    }

                    // reset
                    currentFilePath = filePath;
                    currentFileSection = 0;
                }
            } else {
                if (!currentFileIgnore) {
                    currentSectionData += string;
                }  
            }
        });

        child.stderr.on('data', function(data) {
            console.log('stderr: ' + data);
            reject(data.toString());
        });

        child.on('close', function(code) {
            if (code !== 0) {
                console.log(`icdiff process exited with code ${code}`);
                reject(code);
                return;
            }

            resolve(folders);
        });
    });
};

const writeChangelog = async function(folders) {
    const html = await renderFile(changelogInput, { folders, newTag, oldTag, previewOnlineUrl });
    return writeFile(changelogOutput, html);
};

const main = async function() {
    if (!repository) {
        throw new Error('No repository url given');
    }

    if (!oldTag) {
        throw new Error('No old version tag (--old-tag) given');
    }

    if (!newTag) {
        throw new Error('No new version tag (--new-tag) given');
    }

    if (!previewCommand) {
        throw new Error('No preview command (--preview-cmd) given');
    }

    if (!previewFolder) {
        throw new Error('No preview folder (--preview-folder) given');
    }

    console.log('Start building changelog...');

    if (previewGenerate) {
        console.log('Clean repo folder...')
        await rimraf(repoPath);
        await mkdir(repoPath);

        console.log('Install old and new project...');
        await installTags();

        console.log('Generate previews...');
        await generatePreviews();
    }

    console.log('Start creating diff data...')
    const folders = await diff();

    console.log('Write changelog...')
    await writeChangelog(folders)

    console.log('Preview was built!');
};

main();
