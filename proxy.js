const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ==================== 配置 ====================
const GAME_PORT = 12345;
const INTIFACE_URL = 'ws://127.0.0.1:12347';
const GUI_PORT = 8888;
const PING_ID = 888888;
const PROXY_CMD_ID = 888889;
const MAX_SPEED = 5.0;
// pkg 打包后 __dirname 指向虚拟快照，settings 需要写到 exe 所在的真实目录
const isPkg = typeof process.pkg !== 'undefined';
const RUNTIME_DIR = isPkg ? path.dirname(process.execPath) : __dirname;
const SETTINGS_FILE = path.join(RUNTIME_DIR, 'settings.json');

// ==================== 状态 ====================
const state = {
    mode: 'vibrate',
    gameConnected: false,
    intifaceConnected: false,
    deviceName: '',
    deviceIndex: 0,
    features: [],          // [{index, actuatorType, featureDescriptor, stepCount}]
    featureSettings: {},   // {index: {enabled, sensitivity}}
};

let activeGameWs = null;
let activeIntifaceWs = null;
let activePingInterval = null;
const guiClients = new Set();
const lastPositions = {};
const stopTimers = {};

// ==================== 持久化 ====================
function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
            mode: state.mode, featureSettings: state.featureSettings
        }, null, 2));
    } catch (e) {}
}
function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const d = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
            if (d.mode) state.mode = d.mode;
            if (d.featureSettings) state.featureSettings = d.featureSettings;
            console.log('[*] 已加载上次保存的设置');
        }
    } catch (e) {}
}
loadSettings();

// ==================== GUI 通信 ====================
function broadcast(type, data) {
    const msg = JSON.stringify({ type, ...data });
    for (const c of guiClients) {
        if (c.readyState === WebSocket.OPEN) c.send(msg);
    }
}
function sendFullState(ws) {
    ws.send(JSON.stringify({ type: 'fullState', ...state }));
}
function addLog(msg) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const entry = `[${t}] ${msg}`;
    console.log(entry);
    broadcast('log', { message: entry });
}

// ==================== 信号处理 ====================
function applySens(value, idx) {
    const s = state.featureSettings[idx];
    if (!s || !s.enabled) return 0;
    return Math.min(Math.max(value * s.sensitivity, 0), 1.0);
}

function linearToIntensity(devIdx, featIdx, position, durationMs) {
    const key = `${devIdx}_${featIdx}`;
    const last = lastPositions[key];
    let intensity = 0;
    if (last !== undefined && durationMs > 0) {
        const dist = Math.abs(position - last);
        intensity = Math.min(dist / (Math.max(durationMs, 10) / 1000) / MAX_SPEED, 1.0);
    }
    lastPositions[key] = position;
    return Math.round(intensity * 1000) / 1000;
}

function scheduleAutoStop(devIdx, dur) {
    if (stopTimers[devIdx]) clearTimeout(stopTimers[devIdx]);
    stopTimers[devIdx] = setTimeout(() => {
        fanOut(0);
        addLog('活塞超时，自动归零');
    }, dur + 300);
}

// ==================== 核心：扇出到全部通道 ====================
function fanOut(baseIntensity) {
    if (!activeIntifaceWs || activeIntifaceWs.readyState !== WebSocket.OPEN) return;
    if (state.features.length === 0) return;

    const scalars = state.features.map(f => ({
        Index: f.index,
        Scalar: Math.round(applySens(baseIntensity, f.index) * 1000) / 1000,
        ActuatorType: f.actuatorType
    }));

    activeIntifaceWs.send(JSON.stringify([{
        ScalarCmd: { Id: PROXY_CMD_ID, DeviceIndex: state.deviceIndex, Scalars: scalars }
    }]));

    broadcast('intensity', {
        base: Math.round(baseIntensity * 1000) / 1000,
        channels: scalars.map(s => ({ index: s.Index, value: s.Scalar, type: s.ActuatorType }))
    });
}

// ==================== 游戏消息处理 ====================
function handleGameMsg(text) {
    try {
        const data = JSON.parse(text);
        if (!Array.isArray(data)) return { pass: true, text };

        const pass = [];
        const okIds = [];

        for (const item of data) {
            if (item.VibrateCmd) {
                const sp = item.VibrateCmd.Speeds || [];
                const v = sp.length > 0 ? (sp[0].Speed ?? 0) : 0;
                fanOut(v);
                okIds.push(item.VibrateCmd.Id);
                addLog(`VibrateCmd (${v.toFixed(2)}) -> 全通道`);
            }
            else if (item.RotateCmd) {
                const rot = item.RotateCmd.Rotations || [];
                const v = rot.length > 0 ? (rot[0].Speed ?? 0) : 0;
                fanOut(v);
                okIds.push(item.RotateCmd.Id);
                addLog(`RotateCmd (${v.toFixed(2)}) -> 全通道`);
            }
            else if (item.LinearCmd) {
                const vec = item.LinearCmd.Vectors || [];
                if (vec.length > 0) {
                    const p = vec[0].Position ?? 0, d = vec[0].Duration ?? 200;
                    const v = linearToIntensity(item.LinearCmd.DeviceIndex ?? 0, 0, p, d);
                    scheduleAutoStop(item.LinearCmd.DeviceIndex ?? 0, d);
                    fanOut(v);
                    addLog(`LinearCmd (位置:${p.toFixed(2)} ${d}ms) -> 强度:${v.toFixed(2)}`);
                }
                okIds.push(item.LinearCmd.Id);
            }
            else if (item.ScalarCmd) {
                const sc = item.ScalarCmd.Scalars || [];
                if (sc.length > 0) {
                    const v = sc[0].Scalar ?? 0, tp = sc[0].ActuatorType;
                    fanOut(v);
                    addLog(`ScalarCmd(${tp}) (${v.toFixed(2)}) -> 全通道`);
                }
                okIds.push(item.ScalarCmd.Id);
            }
            else if (item.StopDeviceCmd !== undefined) {
                pass.push(item);
                broadcast('intensity', { base: 0, channels: [] });
                addLog('StopDeviceCmd -> 停止');
            }
            else {
                pass.push(item);
            }
        }

        // 回复 Ok 给游戏
        if (okIds.length > 0 && activeGameWs && activeGameWs.readyState === WebSocket.OPEN) {
            const oks = okIds.filter(id => id != null).map(id => ({ Ok: { Id: id } }));
            if (oks.length > 0) activeGameWs.send(JSON.stringify(oks));
        }

        if (pass.length > 0) return { pass: true, text: JSON.stringify(pass) };
        return { pass: false };
    } catch (e) {
        console.error('[游戏消息异常]', e.message);
        return { pass: true, text };
    }
}

// ==================== Intiface 消息处理 ====================
function handleIntifaceMsg(text) {
    try {
        const data = JSON.parse(text);
        if (!Array.isArray(data)) return text;

        const filtered = data.filter(item =>
            !(item.Ok && (item.Ok.Id === PING_ID || item.Ok.Id === PROXY_CMD_ID))
        );
        if (filtered.length === 0) return null;

        for (const item of filtered) {
            if (item.ServerInfo) {
                addLog(`Intiface 握手成功: ${item.ServerInfo.ServerName}`);
                onHandshakeSuccess();
            }

            if (item.DeviceRemoved) {
                addLog(`设备移除: Index ${item.DeviceRemoved.DeviceIndex}`);
                state.deviceName = '';
                state.features = [];
                broadcast('deviceUpdate', { deviceName: '', features: [], featureSettings: state.featureSettings });
            }

            const devs = [];
            if (item.DeviceList && Array.isArray(item.DeviceList.Devices)) devs.push(...item.DeviceList.Devices);
            else if (item.DeviceAdded) devs.push(item.DeviceAdded);

            for (const dev of devs) {
                const msgs = dev.DeviceMessages || {};
                state.deviceName = dev.DeviceName || 'Unknown';
                state.deviceIndex = dev.DeviceIndex ?? 0;

                state.features = [];
                if (Array.isArray(msgs.ScalarCmd)) {
                    msgs.ScalarCmd.forEach((s, i) => {
                        state.features.push({
                            index: i,
                            actuatorType: s.ActuatorType,
                            featureDescriptor: s.FeatureDescriptor || `Feature ${i}`,
                            stepCount: s.StepCount || 100
                        });
                    });
                }

                for (const f of state.features) {
                    if (!state.featureSettings[f.index]) {
                        state.featureSettings[f.index] = { enabled: true, sensitivity: 1.0 };
                    }
                }

                addLog(`设备: "${state.deviceName}" (${state.features.length} 通道)`);
                state.features.forEach(f => addLog(`  CH${f.index}: ${f.actuatorType} - ${f.featureDescriptor}`));

                spoofDevice(dev);
                saveSettings();
                broadcast('deviceUpdate', {
                    deviceName: state.deviceName,
                    features: state.features,
                    featureSettings: state.featureSettings
                });
            }
        }

        return JSON.stringify(filtered);
    } catch (e) {
        console.error('[Intiface消息异常]', e.message);
    }
    return text;
}

function spoofDevice(dev) {
    const msgs = dev.DeviceMessages || {};
    delete msgs.RotateCmd;
    delete msgs.LinearCmd;
    delete msgs.VibrateCmd;

    if (state.mode === 'vibrate') {
        // 同时兼容 Spec v3 (ScalarCmd) 和 Spec v2 (VibrateCmd)
        msgs.ScalarCmd = [{ ActuatorType: 'Vibrate', FeatureDescriptor: 'Vibration Motor', StepCount: 100 }];
        msgs.VibrateCmd = { FeatureCount: 1 };
        addLog('[伪装] -> Vibrate 振动器 (兼容 v2/v3)');
    } else if (state.mode === 'rotate') {
        msgs.ScalarCmd = [{ ActuatorType: 'Rotate', FeatureDescriptor: 'Rotation Motor', StepCount: 100 }];
        msgs.RotateCmd = [{ ActuatorType: 'Rotate', FeatureDescriptor: 'Rotation Motor', StepCount: 100 }];
        addLog('[伪装] -> Rotate 旋转器 (兼容 v2/v3)');
    } else if (state.mode === 'stroker') {
        msgs.ScalarCmd = [{ ActuatorType: 'Position', FeatureDescriptor: 'Linear Axis', StepCount: 1000 }];
        msgs.LinearCmd = [{ ActuatorType: 'Position', FeatureDescriptor: 'Linear Axis', StepCount: 1000 }];
        addLog('[伪装] -> Stroker 活塞 (兼容 v2/v3)');
    }
}

// ==================== 心跳与握手控制 ====================
let isHandshakeComplete = false;

function onHandshakeSuccess() {
    isHandshakeComplete = true;
    if (activePingInterval) clearInterval(activePingInterval);
    // 握手完全成功后，才启动每 1500ms 的保活 Ping
    activePingInterval = setInterval(() => {
        if (activeIntifaceWs && activeIntifaceWs.readyState === WebSocket.OPEN && isHandshakeComplete) {
            activeIntifaceWs.send(JSON.stringify([{ Ping: { Id: PING_ID } }]));
        }
    }, 1500);
    addLog('心跳保活已就绪 (握手已完成)');
}

// ==================== 游戏代理 ====================
const gameWss = new WebSocket.Server({ port: GAME_PORT }, () => {
    console.log(`[*] 游戏代理: ws://127.0.0.1:${GAME_PORT}`);
});

gameWss.on('connection', (gws) => {
    addLog('游戏已连接！');
    state.gameConnected = true;
    activeGameWs = gws;
    broadcast('status', { gameConnected: true, intifaceConnected: state.intifaceConnected });

    isHandshakeComplete = false;
    let pendingToTarget = [];

    const iws = new WebSocket(INTIFACE_URL);
    activeIntifaceWs = iws;

    iws.on('open', () => {
        state.intifaceConnected = true;
        addLog('已接入 Intiface Central');
        broadcast('status', { gameConnected: true, intifaceConnected: true });

        // 立即排空所有积压的游戏消息（如最关键的 RequestServerInfo 握手包）
        if (pendingToTarget.length > 0) {
            addLog(`排空 ${pendingToTarget.length} 条积压消息到 Intiface`);
            while (pendingToTarget.length > 0) {
                const queued = pendingToTarget.shift();
                iws.send(queued);
            }
        }
    });

    gws.on('message', (m) => {
        const r = handleGameMsg(m.toString());
        if (r.pass) {
            if (iws.readyState === WebSocket.OPEN) {
                iws.send(r.text);
            } else {
                // 如果 Intiface 还在连接中，决不能丢弃！放入缓冲队列！
                pendingToTarget.push(r.text);
            }
        }
    });

    iws.on('message', (m) => {
        const s = handleIntifaceMsg(m.toString());
        if (s && gws.readyState === WebSocket.OPEN) gws.send(s);
    });

    const cleanup = () => {
        isHandshakeComplete = false;
        pendingToTarget = [];
        if (activePingInterval) { clearInterval(activePingInterval); activePingInterval = null; }
        state.gameConnected = false;
        state.intifaceConnected = false;
        activeGameWs = null;
        activeIntifaceWs = null;
        broadcast('status', { gameConnected: false, intifaceConnected: false });
    };

    gws.on('close', () => { addLog('游戏断开'); cleanup(); iws.close(); });
    iws.on('close', () => { addLog('Intiface 断开'); cleanup(); gws.close(); });
    gws.on('error', (e) => { addLog(`游戏错误: ${e.message}`); cleanup(); });
    iws.on('error', (e) => { addLog(`Intiface 错误: ${e.message}`); cleanup(); });
});

gameWss.on('error', (err) => {
    if (err.code === 'EADDRINUSE')
        console.error(`[错误] 端口 ${GAME_PORT} 被占用！请确认 Intiface 端口已改为 12347。`);
});

// ==================== GUI 服务器 ====================
const guiServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, content) => {
            if (err) { res.writeHead(500); res.end('Error'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
    } else {
        res.writeHead(404); res.end('Not Found');
    }
});

const guiWss = new WebSocket.Server({ server: guiServer });

guiWss.on('connection', (ws) => {
    guiClients.add(ws);
    sendFullState(ws);
    ws.on('message', (m) => {
        try { handleGuiMsg(JSON.parse(m.toString())); } catch (e) {}
    });
    ws.on('close', () => guiClients.delete(ws));
});

function handleGuiMsg(msg) {
    switch (msg.type) {
        case 'setMode':
            if (msg.mode === state.mode) return;
            state.mode = msg.mode;
            addLog(`模式切换: ${state.mode}`);
            for (const k in lastPositions) delete lastPositions[k];
            for (const k in stopTimers) { clearTimeout(stopTimers[k]); delete stopTimers[k]; }
            if (activeGameWs && activeGameWs.readyState === WebSocket.OPEN) {
                addLog('断开游戏以触发重连...');
                activeGameWs.close();
            }
            saveSettings();
            broadcast('modeUpdate', { mode: state.mode });
            break;
        case 'setSensitivity':
            if (state.featureSettings[msg.index]) {
                state.featureSettings[msg.index].sensitivity = Math.round(Math.min(Math.max(msg.value, 0), 3.0) * 100) / 100;
                saveSettings();
                broadcast('settingsUpdate', { featureSettings: state.featureSettings });
            }
            break;
        case 'setEnabled':
            if (state.featureSettings[msg.index]) {
                state.featureSettings[msg.index].enabled = msg.enabled;
                addLog(`通道 ${msg.index} ${msg.enabled ? '启用' : '禁用'}`);
                saveSettings();
                broadcast('settingsUpdate', { featureSettings: state.featureSettings });
            }
            break;
        case 'test':
            fanOut(msg.intensity ?? 0);
            break;
    }
}

function launchAppWindow() {
    const url = `http://127.0.0.1:${GUI_PORT}`;
    const candidates = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];
    
    let browserPath = candidates.find(p => fs.existsSync(p));
    if (browserPath) {
        const tempProfile = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'intiface_proxy_window_profile');
        const args = [
            `--app=${url}`,
            `--window-size=680,880`,
            `--user-data-dir=${tempProfile}`
        ];
        try {
            const child = require('child_process').spawn(browserPath, args, {
                detached: false,
                stdio: 'ignore'
            });
            child.on('exit', () => {
                console.log('[*] 本地窗口已关闭，代理自动退出。');
                process.exit(0);
            });
            console.log('[*] 已启动本地独立窗口');
            return;
        } catch (e) {
            console.error('[*] 启动本地窗口失败，回退到默认浏览器:', e.message);
        }
    }
    
    // 如果没有找到 Edge/Chrome，回退到系统默认浏览器
    require('child_process').exec(`start ${url}`);
}

guiServer.listen(GUI_PORT, () => {
    console.log(`[*] 控制面板: http://127.0.0.1:${GUI_PORT}`);
    console.log(`[*] Intiface:  ${INTIFACE_URL}`);
    console.log('='.repeat(50));
    launchAppWindow();
});

