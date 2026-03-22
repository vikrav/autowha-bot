const SERVER = 'https://autowha.com';
const TOKEN = process.env.TOKEN || '';
const fs = require('fs');
const path = require('path');

let userSettings = null;
let sock = null;

// ── Server se settings fetch karo ──
async function fetchSettings() {
  try {
    const res = await fetch(`${SERVER}/api/settings`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const data = await res.json();
    if (data && data.buttons) {
      userSettings = data;
      console.log('✅ Settings sync ho gayi!');
    }
  } catch (e) {
    console.log('⚠️ Sync error:', e.message);
  }
}

// ── Client save to server ──
async function saveClient(phone, name) {
  try {
    await fetch(`${SERVER}/api/clients`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, name })
    });
  } catch (e) {}
}

// ── Message save to server ──
async function saveMessage(phone, incoming, outgoing) {
  try {
    await fetch(`${SERVER}/api/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, incoming, outgoing })
    });
  } catch (e) {}
}

// ── Menu builder ──
function buildMenu(buttons, name, menuHeading) {
  const heading = (menuHeading || '{naam} ke liye menu:').replace('{naam}', name || '');
  let txt = name ? `${heading}\n\n` : '';
  (buttons || []).forEach((btn, i) => { txt += `${i + 1}. ${btn.label}\n`; });
  if (buttons?.length) txt += '\n_0 = Wapas Home_';
  return txt;
}

// ── Auto Reply ──
const clientStates = {};

async function handleAutoReply(from, text) {
  try {
    if (!userSettings) await fetchSettings();
    if (!userSettings) return;

    const phone = from.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    const msg = text.trim().toLowerCase();
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    const typingDelay = (txt) => Math.min(1500 + txt.split(' ').length * 80, 4000);

    const sendMsg = async (txt) => {
      await sock.sendPresenceUpdate('composing', from);
      await delay(typingDelay(txt));
      await sock.sendPresenceUpdate('paused', from);
      await sock.sendMessage(from, { text: txt });
      await delay(500);
    };

    // Client state memory mein
    if (!clientStates[phone]) {
      clientStates[phone] = { step: 'welcome', name: '', currentMenu: null, isNew: true };
    }
    let client = clientStates[phone];

    // Reset on hi/hello/0
    if (['hi', 'hello', 'hii', 'start', 'namaste', 'hey', '0'].includes(msg)) {
      client.step = 'welcome';
      client.currentMenu = null;
    }

    // ── Welcome ──
    if (client.step === 'welcome') {
      if (client.name && client.name.length > 1) {
        const welcome = (userSettings.welcomeMsg || 'Aapka swagat hai! 🙏').replace('{naam}', client.name);
        client.step = 'main_menu';
        client.currentMenu = null;
        await sendMsg(welcome + '\n\n' + buildMenu(userSettings.buttons || [], client.name, userSettings.menuHeading));
        await saveMessage(phone, text, welcome);
      } else {
        const welcome = userSettings.welcomeMsg || 'Aapka swagat hai! 🙏';
        client.step = 'ask_name';
        client.isNew = false;
        await sendMsg(welcome);
        await sendMsg(userSettings.askNameMsg || 'Aapka naam kya hai?');
        await saveMessage(phone, text, welcome);
      }
      return;
    }

    // ── Ask Name ──
    if (client.step === 'ask_name') {
      if (text.trim().length > 1) {
        client.name = text.trim();
        client.step = 'main_menu';
        client.currentMenu = null;
        await saveClient(phone, client.name);
        await sendMsg(`Shukriya *${client.name}*! 😊\n\n` + buildMenu(userSettings.buttons || [], client.name, userSettings.menuHeading));
        await saveMessage(phone, text, client.name);
      } else {
        await sendMsg(userSettings.askNameMsg || 'Kripya apna naam likhein:');
      }
      return;
    }

    // ── Main Menu / Submenu ──
    const num = parseInt(msg);
    let currentButtons = userSettings.buttons || [];

    if (client.currentMenu) {
      try {
        const p = JSON.parse(client.currentMenu);
        let temp = userSettings.buttons || [];
        for (const idx of p) { if (temp[idx]) temp = temp[idx].children || []; }
        currentButtons = temp;
      } catch (e) {}
    }

    const matched = !isNaN(num) && num >= 1 && num <= currentButtons.length ? currentButtons[num - 1] : null;

    if (matched) {
      if (matched.children?.length) {
        const p = client.currentMenu ? JSON.parse(client.currentMenu) : [];
        client.currentMenu = JSON.stringify([...p, currentButtons.indexOf(matched)]);
        const reply = `*${matched.label}*\n\n` + matched.children.map((b, i) => `${i + 1}. ${b.label}`).join('\n') + '\n\n_0 = Wapas_';
        await sendMsg(reply);
        await saveMessage(phone, text, reply);
      } else {
        const reply = matched.reply || matched.label;
        client.currentMenu = null;
        client.step = 'main_menu';
        await sendMsg(reply);
        await delay(800);
        await sendMsg(buildMenu(userSettings.buttons || [], client.name || '', userSettings.menuHeading));
        await saveMessage(phone, text, reply);
      }
    } else {
      client.currentMenu = null;
      await sendMsg(buildMenu(userSettings.buttons || [], client.name || '', userSettings.menuHeading));
      await saveMessage(phone, text, 'menu');
    }
  } catch (err) {
    console.error('AutoReply error:', err.message);
  }
}

// ── WhatsApp Connect ──
async function startBot() {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
  const { toDataURL } = require('qrcode');
  const pino = require('pino');

  const authDir = path.join(__dirname, 'wa_auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['AutoWha Bot', 'Chrome', '114.0'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 QR Code upar dikh raha hai — WhatsApp se scan karo!\n');
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp Connected! Bot chal raha hai...');
      await fetchSettings();
      // Har 30 second mein sync karo
      setInterval(fetchSettings, 30000);
    }
    if (connection === 'close') {
      const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      if (!loggedOut) {
        console.log('🔄 Reconnecting...');
        setTimeout(startBot, 5000);
      } else {
        console.log('❌ Logged out! Setup dobara karo.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (text) await handleAutoReply(msg.key.remoteJid, text);
    }
  });
}

// ── Start ──
console.log('🚀 AutoWha Bot shuru ho raha hai...');
console.log(`🌐 Server: ${SERVER}`);
fetchSettings().then(() => startBot());
