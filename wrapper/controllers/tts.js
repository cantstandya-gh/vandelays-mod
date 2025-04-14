const Asset = require("../models/asset");
const fs = require("fs");
const httpz = require("@octanuary/httpz");
const info = require("../data/voices");
const mp3Duration = require("mp3-duration");
const processVoice = require("../models/tts");
const tempfile = require("tempfile");

const group = new httpz.Group();
const { voices } = require("../data/voices-runtime");
Object.assign(voices, JSON.parse(JSON.stringify(info.voices)));
const langs = {};
let xml = "";

(async () => {
  if (process.platform === "win32") {
    console.log("Windows detected. Loading node-balcon...");
  
    try {
      const path = require("path");
      const Balabolka = require("../../utils/node-balcon");
  
      const balcon = new Balabolka({
        balaPath: path.join(__dirname, "../../utils/balcon/balcon.exe")
      });
  
      const sapiVoiceData = await balcon.listVoices();
      const sapis = sapiVoiceData["SAPI 5:"] || {};
  
      Object.entries(sapis).forEach(([name, meta]) => {
        let cleanedName = name.replace(/^Microsoft /i, "").replace(/ Desktop$/i, "").trim();
        const originalTitle = cleanedName.toLowerCase().replace(/\s+/g, "_");
  
        // Title deduplication logic
        let title = originalTitle;
        let suffix = "";
        let i = 1;
        while (voices[title] || baseVoiceMap[title]) {
          suffix = i === 1 ? "_sapi5" : `_sapi5_${i}`;
          title = originalTitle + suffix;
          i++;
        }
  
        // Description handling
        let desc = cleanedName;
        const conflict = Object.values(baseVoiceMap).some(v => v.desc?.toLowerCase() === desc.toLowerCase());
        if (conflict) desc += " (SAPI5)";
  
        voices[title] = {
          lang: meta.lang?.toLowerCase() || "en",
          country: meta.lang?.toUpperCase() || "US",
          gender: meta.gender === "F" ? "F" : "M",
          desc,
          arg: name,
          source: "sapi5"
        };
      });
    } catch (e) {
      console.warn("Failed to load SAPI5 voices:", e.message);
    }
  }
  
  if (process.platform === "darwin") {
    console.log("MacOS detected. Loading node-macintalk...");
    try {
      const { listVoices } = require("../../utils/node-macintalk");
      const list = await listVoices();
      const macVoices = list?.macOS;

      Object.entries(macVoices || {}).forEach(([name, v]) => {
        const normalized = name.toLowerCase().replace(/\s+/g, '_').replace(/[()]/g, '');
        let title = normalized;
        let desc = name.replace(/\s+/g, ' ').trim();

        const suffixMatch = desc.match(/\(([^)]+)\)/);
        const suffix = suffixMatch?.[1];
        const baseDesc = desc.replace(/\s*\([^)]*\)/g, '').trim();

        if (suffix === 'Enhanced') desc = baseDesc + ' (E)';
        else if (suffix === 'Premium') desc = baseDesc + ' (P)';
        else desc = baseDesc;

        const accentMap = { US: 'American', GB: 'British', IE: 'Irish', AU: 'Australian', IN: 'Indian', ZA: 'S. African' };
        const accent = accentMap[v.country];
        if (accent && accent !== 'American') {
          const hasOtherAccents = Object.values(macVoices).some(vo => vo.label?.replace(/\s*\([^)]*\)/g, '') === baseDesc && vo.country !== 'US');
          if (hasOtherAccents) desc += ` (${accent})`;
        }

        const conflictExists = Object.values(voices).some(vo => vo.desc.replace(/\s*\([^)]*\)/g, '') === baseDesc && vo.language === v.language && vo.source !== 'apple');
        if (conflictExists && !desc.includes('(E)') && !desc.includes('(P)')) desc += ' (Apple)';

        let count = 1;
        while (voices[title]) {
          title = `${normalized}${count++}`;
        }

        const gender = v.gender?.startsWith("F") ? "F" : "M";
        const language = v.language;
        const country = v.country;

        voices[title] = {
          desc,
          gender,
          language,
          country,
          source: "apple",
          arg: name
        };
      });
    } catch (err) {
      console.error("Failed to load Apple voices:", err);
    }
  }

  Object.keys(voices).forEach((i) => {
    const v = voices[i], l = v.language;
    langs[l] = langs[l] || [];
    langs[l].push(`<voice id="${i}" desc="${v.desc}" sex="${v.gender}" demo-url="" country="${v.country}" plus="N"/>`);
  });

  xml = `${process.env.XML_HEADER}<voices>${Object.keys(langs).sort().map(i => {
    const v = langs[i], l = info.languages[i];
    return `<language id="${i}" desc="${l}">${v.join('')}</language>`;
  }).join('')}</voices>`;
})();

group.route("POST", "/goapi/getTextToSpeechVoices/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=UTF-8");
  res.end(xml);
});

group.route("POST", "/goapi/convertTextToSoundAsset/", async (req, res) => {
  const { voice, text: rawText } = req.body;
  if (!voice || !rawText) return res.status(400).end();

  const filepath = tempfile(".mp3");
  const writeStream = fs.createWriteStream(filepath);
  const text = rawText.substring(0, 320);

  try {
    const data = await processVoice(voice, text);

    if (typeof data.on === "function") {
      data.pipe(writeStream);
    } else {
      writeStream.end(data);
    }

    writeStream.on("close", async () => {
      const duration = await mp3Duration(filepath) * 1e3;
      const meta = {
        duration,
        type: "sound",
        subtype: "tts",
        title: `[${voices[voice].desc}] ${text}`
      };
      const id = await Asset.save(filepath, "mp3", meta);
      res.end(`0<response><asset><id>${id}</id><enc_asset_id>${id}</enc_asset_id><type>sound</type><subtype>tts</subtype><title>${meta.title}</title><published>0</published><tags></tags><duration>${meta.duration}</duration><downloadtype>progressive</downloadtype><file>${id}</file></asset></response>`);
    });
  } catch (e) {
    console.error("TTS generation error:", e);
    res.end(`1<error><code>ERR_ASSET_404</code><message>${e}</message><text></text></error>`);
  }
});

module.exports = group;