// build.js - 自动打包为单个 exe
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DIST = path.join(__dirname, 'dist');
if (!fs.existsSync(DIST)) fs.mkdirSync(DIST);

console.log('[1/5] 内联 HTML 到 JS...');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let proxy = fs.readFileSync(path.join(__dirname, 'proxy.js'), 'utf8');

// 在文件开头插入内联 HTML 常量
proxy = `const __INLINE_HTML__ = ${JSON.stringify(html)};\n` + proxy;

// 替换 fs.readFile 读取 HTML 的代码为直接使用内联内容
proxy = proxy.replace(
    `fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, content) => {`,
    `{ const err = null; const content = __INLINE_HTML__; ((_err, _content) => {`
);
// 匹配对应的闭合
proxy = proxy.replace(
    `res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });\n            res.end(content);\n        });`,
    `res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });\n            res.end(content);\n        })(err, content); }`
);

fs.writeFileSync(path.join(DIST, 'proxy-inline.js'), proxy);
console.log('    -> proxy-inline.js 已生成');

console.log('[2/5] 使用 esbuild 打包依赖...');
execSync(`npx esbuild "${path.join(DIST, 'proxy-inline.js')}" --bundle --platform=node --outfile="${path.join(DIST, 'bundle.js')}"`, { stdio: 'inherit' });
console.log('    -> bundle.js 已生成');

console.log('[3/5] 生成 SEA blob...');
const seaConfig = {
    main: path.join(DIST, 'bundle.js'),
    output: path.join(DIST, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true
};
fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execSync(`node --experimental-sea-config "${path.join(DIST, 'sea-config.json')}"`, { stdio: 'inherit' });
console.log('    -> sea-prep.blob 已生成');

console.log('[4/5] 复制 Node 运行时...');
const exeName = 'Intiface信号转换代理.exe';
const exePath = path.join(DIST, exeName);
fs.copyFileSync(process.execPath, exePath);
console.log(`    -> ${exeName} 已复制`);

console.log('[5/5] 注入 SEA blob...');
try {
    // 移除签名（如果有）
    try { execSync(`npx --yes postject "${exePath}" NODE_SEA_BLOB "${path.join(DIST, 'sea-prep.blob')}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite`, { stdio: 'inherit' }); }
    catch (e) {
        // 如果 signtool 不可用，尝试不移除签名
        execSync(`npx --yes postject "${exePath}" NODE_SEA_BLOB "${path.join(DIST, 'sea-prep.blob')}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite`, { stdio: 'inherit' });
    }
    console.log('    -> blob 已注入');
} catch (e) {
    console.error('注入失败:', e.message);
    process.exit(1);
}

// 清理临时文件
try {
    fs.unlinkSync(path.join(DIST, 'proxy-inline.js'));
    fs.unlinkSync(path.join(DIST, 'bundle.js'));
    fs.unlinkSync(path.join(DIST, 'sea-prep.blob'));
    fs.unlinkSync(path.join(DIST, 'sea-config.json'));
} catch (e) {}

const size = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
console.log(`\n========================================`);
console.log(`  打包完成！`);
console.log(`  文件: ${exePath}`);
console.log(`  大小: ${size} MB`);
console.log(`========================================`);
