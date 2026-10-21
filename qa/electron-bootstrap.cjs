const { app } = require('electron');
if (!process.env.VK_PLAYER_QA_PROFILE) throw new Error('QA requires an isolated profile directory');
app.setPath('userData', process.env.VK_PLAYER_QA_PROFILE);
import('../electron/main.mjs');
