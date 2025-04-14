/*
tts
*/
const brotli = require("brotli");
const fileUtil = require("../../utils/realFileUtil");
const fs = require("fs");
const https = require("https");
const http = require("http");
const voices = require("../data/voices-runtime").voices;

/**
 * uses tts demos to generate tts
 * @param {string} voiceName voice name
 * @param {string} text text
 * @returns {Buffer}
 */
module.exports = function processVoice(voiceName, text) {
	return new Promise(async (resolve, rej) => {
		const voice = voices[voiceName];
		if (!voice) {
			return rej("Requested voice is not supported");
		}

		try {
			switch (voice.source) {
				case "acapela": {
					let fakeEmailArray = [];
					for (let c = 0; c < 15; c++) fakeEmailArray.push(~~(65 + Math.random() * 26));
					const email = `${String.fromCharCode.apply(null, fakeEmailArray)}@gmail.com`;

					let req = https.request(
						{
							hostname: "acapelavoices.acapela-group.com",
							path: "/index/getnonce",
							method: "POST",
							headers: {
								"Content-Type": "application/x-www-form-urlencoded",
							},
						},
						(r) => {
							let buffers = [];
							r.on("data", (b) => buffers.push(b));
							r.on("end", () => {
								const nonce = JSON.parse(Buffer.concat(buffers)).nonce;
								let req = https.request(
									{
										hostname: "h-ir-ssd-1.acapela-group.com",
										path: "/Services/Synthesizer",
										method: "POST",
										headers: {
											"Content-Type": "application/x-www-form-urlencoded",
										},
									},
									(r) => {
										if (r.statusCode === 500) {
											return rej("Acapela request failed: HTTP 500 Internal Server Error");
										}

										let buffers = [];
										r.on("data", (d) => buffers.push(d));
										r.on("end", () => {
											const html = Buffer.concat(buffers).toString();

											if (html.includes("err_code=")) {
												return rej("Acapela returned err_code in response.");
											}

											const match = html.match(/&snd_url=(https:\/\/[^\s&"]+\.mp3)/);
											if (!match || !match[1]) {
												return rej("Acapela MP3 URL not found in response.");
											}

											const audioUrl = match[1];
											https.get(audioUrl, resolve).on("error", rej);
										});
										r.on("error", rej);
									}
								).on("error", rej);
								req.end(
									new URLSearchParams({
										cl_vers: "1-30",
										req_text: text,
										cl_login: "AcapelaGroup",
										cl_app: "AcapelaGroup_WebDemo_Android",
										req_comment: `{"nonce":"${nonce}","user":"${email}"}`,
										prot_vers: 2,
										cl_env: "ACAPELA_VOICES",
										cl_pwd: "",
										req_voice: voice.arg,
										req_echo: "ON",
									}).toString()
								);
							});
						}
					).on("error", rej);
					req.end(
						new URLSearchParams({
							json: `{"googleid":"${email}"`,
						}).toString()
					);
					break;
				}

				case "apple": {
					const { MacinTalk } = require("../../utils/node-macintalk");
					try {
						const tts = new MacinTalk()
							.voice(voice.arg)
							.text(text);

						tts.generate()
							.then(buffer => {
								console.log("Generated buffer size:", buffer?.length);
								return fileUtil.convertToMp3(buffer, "aiff")
									.then(mp3 => resolve(mp3))
									.catch(err => rej(err));
							})
							.catch(err => rej("Apple TTS failed: " + err.message));
					} catch (err) {
						reject("Apple TTS exception: " + err.message);
					}
					break;
				}

				case "sapi5": {
					const Balabolka = require("../../utils/node-balcon");
					const path = require("path");
					const balcon = new Balabolka({
						balaPath: path.join(__dirname, "../../utils/balcon/balcon.exe")
					});
					
					balcon
						.voice(voice.arg)
						.text(text)
						.generate()
						.then(buffer => {
							fileUtil.convertToMp3(buffer, "wav")
							.then(mp3 => resolve(mp3))
							.catch(err => rej(err));
						})
						.catch(err => rej("SAPI5 TTS failed: " + err.message));					
					break;
				}				

				case "cepstral": {
					https.get("https://www.cepstral.com/en/demos", async (r) => {
						r.on("error", (e) => rej(e));
						const cookie = r.headers["set-cookie"];
						const q = new URLSearchParams({
							voiceText: text,
							voice: voice.arg,
							createTime: 666,
							rate: 170,
							pitch: 1,
							sfx: "none"
						}).toString();

						https.get(
							{
								hostname: "www.cepstral.com",
								path: `/demos/createAudio.php?${q}`,
								headers: { Cookie: cookie }
							},
							(r2) => {
								let body = "";
								r2.on("error", (e) => rej(e));
								r2.on("data", (c) => body += c);
								r2.on("end", () => {
									const json = JSON.parse(body);
									https.get(`https://www.cepstral.com${json.mp3_loc}`, (r3) => {
										r3.on("error", (e) => rej(e));
										resolve(r3);
									});
								});
							}
						);
					});
					break;
				}

				case "cereproc": {
					const vUtil = require("../../utils/voiceUtil");
					const { lang, accent } = vUtil.resolveCereprocAccent(voice);
					const postData = new URLSearchParams({
						text,
						language: lang,
						accent: accent,
						voice: voice.arg,
						form_id: "live_demo_form",
						_triggering_element_name: "op",
						_triggering_element_value: "Convert to Speech",
						_drupal_ajax: 1
					}).toString();

					const reqOptions = {
						hostname: "app.cereproc.com",
						path: "/live-demo?ajax_form=1&_wrapper_format=drupal_ajax",
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded",
							"Content-Length": Buffer.byteLength(postData)
						}
					};

					const req = https.request(reqOptions, (res) => {
						let data = [];
						res.on("data", chunk => data.push(chunk));
						res.on("end", () => {
							try {
								const json = JSON.parse(Buffer.concat(data).toString());
								const result = json.find(obj => obj.selector === "#live-demo-result");
								const html = result?.data || "";
								const match = html.match(/https:\/\/cerevoice\.s3\.amazonaws\.com\/[^\"']+\.wav/);

								if (!match || !match[0]) return reject("Cereproc audio link not found");

								const audioURL = match[0].replace(/\\/g, "");
								https.get(audioURL, (stream) => {
									fileUtil.convertToMp3(stream, "wav")
										.then(mp3Buffer => resolve(mp3Buffer))
										.catch(err => reject("MP3 conversion failed: " + err));
								}).on("error", err => reject("Failed to download Cereproc WAV: " + err));
							} catch (err) {
								reject("Cereproc response parsing failed: " + err);
							}
						});
					});

					req.on("error", (err) => reject("Cereproc request failed: " + err));
					req.write(postData);
					req.end();
					break;
				}

				case "polly": {
					const q = new URLSearchParams({
						voice: voice.arg,
						text: text,
					}).toString();

					https
						.get(`https://api.streamelements.com/kappa/v2/speech?${q}`, resolve)
						.on("error", rej);
					break;
				}

				case "readloud": {
					const body = new URLSearchParams({
						but1: text,
						butS: 0,
						butP: 0,
						butPauses: 0,
						butt0: "Submit",
					}).toString();
					const req = https.request(
						{
							hostname: "readloud.net",
							path: voice.arg,
							method: "POST",
							headers: {
								"Content-Type": "application/x-www-form-urlencoded"
							}
						},
						(r) => {
							let buffers = [];
							r.on("error", (e) => rej(e));
							r.on("data", (b) => buffers.push(b));
							r.on("end", () => {
								const html = Buffer.concat(buffers);
								const beg = html.indexOf("/tmp/");
								const end = html.indexOf("mp3", beg) + 3;
								const sub = html.subarray(beg, end).toString();

								https.get(`https://readloud.net${sub}`, (r2) => {
									r2.on("error", (e) => rej(e));
									resolve(r2);
								});
							});
						}
					).on("error", (e) => rej(e));
					req.end(body);
					break;
				}

				case "acapela2": {
					var q = new URLSearchParams({
						voiceSpeed: 100,
						inputText: Buffer.from(text, 'utf8').toString('base64'),
					}).toString();
					https.get(
						{
							host: "voice.reverso.net",
							path: `/RestPronunciation.svc/v1/output=json/GetVoiceStream/voiceName=${voice.arg}?${q}`,
							headers: {
								'Host': 'voice.reverso.net',
								'Referer': 'voice.reverso.net',
								'User-Agent': 'Mozilla/5.0 (Windows; U; Windows NT 6.1; en-US) AppleWebKit/533.2 (KHTML, like Gecko) Chrome/6.0',
								'Connection': 'Keep-Alive'
							}
						},
						(r) => {
							resolve(r)
						}
					);
					break;
				}

				case "sapi4": {
					const voiceEncoded = encodeURIComponent(voice.arg);
					let pitch, speed; // ✅ Unpopulated by default
				
					if (voice.desc.includes("BonziBUDDY")) {
						pitch = 140;
						speed = 157;
					} else {
						try {
							const limits = await new Promise((resolveLimit, rejectLimit) => {
								https.get(`https://www.tetyys.com/SAPI4/VoiceLimitations?voice=${voiceEncoded}`, (r) => {
									let body = "";
									r.on("data", (chunk) => body += chunk);
									r.on("end", () => {
										try {
											const json = JSON.parse(body);
											resolveLimit({
												pitch: json.defPitch,
												speed: json.defSpeed
											});
										} catch (err) {
											console.error("SAPI4 voice limitation error (bad JSON):", body);
											rejectLimit("Invalid or unsupported SAPI4 voice: " + voice.arg);
										}
									});
									r.on("error", rejectLimit);
								}).on("error", rejectLimit);
							});
				
							pitch = limits.pitch;
							speed = limits.speed;
						} catch (err) {
							return reject("SAPI4 limitation fetch failed: " + err);
						}
					}
				
					// ✅ Build query params dynamically
					const q = new URLSearchParams({ text, voice: voice.arg });
					if (pitch !== undefined) q.set("pitch", pitch);
					if (speed !== undefined) q.set("speed", speed);
				
					https.get({
						hostname: "www.tetyys.com",
						path: `/SAPI4/SAPI4?${q.toString()}`,
					}, (r) => {
						let totalSize = 0;
						r.on("data", chunk => totalSize += chunk.length);
						r.on("end", () => console.log("SAPI4 audio size:", totalSize));
				
						fileUtil.convertToMp3(r, "wav").then(resolve).catch(rej);
					}).on("error", rej);
				
					break;
				}				

				case "svox2": {
					const q = new URLSearchParams({
						speed: 0,
						apikey: "38fcab81215eb701f711df929b793a89",
						text: text,
						action: "convert",
						voice: voice.arg,
						format: "mp3",
						e: "audio.mp3"
					}).toString();

					https
						.get(`https://api.ispeech.org/api/rest?${q}`, resolve)
						.on("error", rej);
					break;
				}

				case "tiktok": {
					const req = https.request(
						{
							hostname: "tiktok-tts.weilnet.workers.dev",
							path: "/api/generation",
							method: "POST",
							headers: {
								"Content-type": "application/json"
							}
						},
						(r) => {
							let body = "";
							r.on("error", (e) => rej(e));
							r.on("data", (b) => body += b);
							r.on("end", () => {
								const json = JSON.parse(body);
								if (json.success != true) {
									return rej(json.error);
								}
								resolve(Buffer.from(json.data, "base64"));
							});
							r.on("error", rej);
						}
					).on("error", (e) => rej(e));
					req.end(JSON.stringify({
						text: text,
						voice: voice.arg
					}));
					break;
				}

				case "vocalware": {
					const [EID, LID, VID] = voice.arg;
					const q = new URLSearchParams({
						EID,
						LID,
						VID,
						TXT: text,
						EXT: "mp3",
						FNAME: "",
						ACC: 15679,
						SceneID: 2703396,
						HTTP_ERR: "",
					}).toString();

					https
						.get(
							{
								hostname: "cache-a.oddcast.com",
								path: `/tts/genB.php?${q}`,
								headers: {
									"Host": "cache-a.oddcast.com",
									"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:107.0) Gecko/20100101 Firefox/107.0",
									"Accept": "*/*",
									"Accept-Language": "en-US,en;q=0.5",
									"Accept-Encoding": "gzip, deflate, br",
									"Origin": "https://www.oddcast.com",
									"DNT": 1,
									"Connection": "keep-alive",
									"Referer": "https://www.oddcast.com/",
									"Sec-Fetch-Dest": "empty",
									"Sec-Fetch-Mode": "cors",
									"Sec-Fetch-Site": "same-site"
								}
							}, resolve
						)
						.on("error", rej);
					break;
				}
				case "nuance": {
					const q = new URLSearchParams({
						voice_name: voice.arg,
						speak_text: text,
					}).toString();

					https
						.get(`https://voicedemo.codefactoryglobal.com/generate_audio.asp?${q}`, resolve)
						.on("error", rej);
					break;
				}
				case "svox": {
					const q = new URLSearchParams({
						speed: 0,
						apikey: "ispeech-listenbutton-betauserkey",
						text: text,
						action: "convert",
						voice: voice.arg,
						format: "mp3",
						e: "audio.mp3"
					}).toString();

					https
						.get(`https://api.ispeech.org/api/rest?${q}`, resolve)
						.on("error", rej);
					break;
				}
				// again thx unicom for this fix
				case "voiceforge": {
					const vUtil = require("../../utils/voiceUtil");
					// the people want this
					text = await vUtil.convertText(text, voice.arg);
					let fakeEmailArray = [];
					for (let c = 0; c < 15; c++) fakeEmailArray.push(~~(65 + Math.random() * 26));
					const email = `${String.fromCharCode.apply(null, fakeEmailArray)}@gmail.com`;
					const queryString = new URLSearchParams({
						msg: text,
						voice: voice.arg,
						email: email
					}).toString();
					const req = https.request(
						{
							hostname: "api.voiceforge.com",
							path: `/swift_engine?${queryString}`,
							method: "GET",
							headers: {
								"Host": "api.voiceforge.com",
								"User-Agent": "just_audio/2.7.0 (Linux;Android 14) ExoPlayerLib/2.15.0",
								"Connection": "Keep-Alive",
								"Http_x_api_key": "8b3f76a8539",
								"Accept-Encoding": "gzip, deflate, br",
								"Icy-Metadata": "1",
							}
						}, (r) => {
							r.on("error", (e) => rej(e));
							fileUtil.convertToMp3(r, "wav")
								.then(stream => resolve(stream))
								.catch((e) => rej(e));
						}
					).on("error", (e) => rej(e));
					req.end();
					break;
				}

				default: {
					return rej("Not implemented");
				}
			}
		} catch (e) {
			return rej(e);
		}
	});
};