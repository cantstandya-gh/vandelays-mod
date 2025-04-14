// node-macintalk/index.js
const fs = require("fs");
const os = require("os");
const { spawn, execSync } = require("child_process");
const { recommended } = require("./data.gen");
const createTempFile = require("./tempfile");
const path = require("path");

class MacinTalk {
  constructor() {
    if (os.platform() !== "darwin") {
      throw new Error("MacinTalk only runs on macOS.");
    }

    try {
      execSync("command -v say");
    } catch (e) {
      throw new Error("The `say` command is required but was not found.");
    }

    this._voice = "Alex";
    this._text = "";
  }

  voice(name) {
    this._voice = name;
    return this;
  }

  text(str) {
    this._text = str;
    return this;
  }

  static listVoices() {
    const output = execSync(`say -v "?"`).toString();
    const lines = output.trim().split("\n");

    const voices = {};

    for (const line of lines) {
      const match = line.match(/^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s+#/);
      if (!match) continue;

      const name = match[1].trim();
      const lang = match[2];

      const voiceEntry =
        recommended.find(v => v.label === `Apple ${name}` && v.localizedName === "apple") ||
        recommended.find(v => v.name === name && v.localizedName === "apple");

      const cleanName = voiceEntry?.label?.startsWith("Apple ")
        ? voiceEntry.label.replace(/^Apple\s+/, "")
        : name;

      const gender =
        voiceEntry?.gender?.[0].toUpperCase() ||
        "M";

      voices[cleanName] = {
        description: cleanName,
        vendor: "Apple",
        age: "unknown",
        gender,
        language: lang.split("_")[0],
        country: lang.split("_")[1],
        lang
      };
    }

    return Promise.resolve({ "macOS": voices });
  }

  generate(outPath = null) {
    return new Promise((resolve, reject) => {
      if (!this._text) return reject(new Error("No text specified."));
  
      const tempOut = outPath || createTempFile();
      const args = ["-v", this._voice, "-o", tempOut, this._text];
      const proc = spawn("say", args);
  
      let stderr = "";
  
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
  
      proc.on("error", (err) => {
        return reject(new Error(`Failed to spawn say command: ${err.message}`));
      });
  
      proc.on("close", (code) => {
        if (code !== 0) {
          return reject(
            new Error(`say command failed with exit code ${code}\n${stderr || "No stderr output."}`)
          );
        }
  
        if (outPath) return resolve(path.resolve(outPath));
  
        fs.readFile(tempOut, (err, buffer) => {
          fs.unlink(tempOut, () => {});
          if (err) return reject(new Error(`Failed to read generated audio file: ${err.message}`));
          resolve(buffer);
        });
      });
    });
  }  
}

module.exports = {
  MacinTalk,
  listVoices: MacinTalk.listVoices,
};
