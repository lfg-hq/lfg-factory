/**
 * The meeting bot's camera: an LFG card (the rocket on the light violet of LFG's site, with how
 * to talk to it) drawn on a canvas inside the page and handed to Meet as the camera. The meeting browser
 * has no camera device, so the card also lists itself as one. Meet then shows the card in the
 * bot's tile instead of a letter on a colour taken from the profile.
 *
 * installCard runs in the page (page.addInitScript), before any of Meet's own scripts.
 */
import { readFileSync } from "node:fs";

/** The rocket as a data URL, read once from LFG's own logo. */
export function rocketDataUrl() {
  const png = readFileSync(new URL("../public/images/logo_lfg.png", import.meta.url));
  return "data:image/png;base64," + png.toString("base64");
}

/** Runs in the page. `opts`: { rocket: data URL, hint }. */
export function installCard(opts) {
  const md = navigator.mediaDevices;
  if (!md || window.__lfgCard) return;
  const W = 960, H = 540, FPS = 5;
  const DEVICE = { deviceId: "lfg-card", groupId: "lfg-card", kind: "videoinput", label: "LFG" };

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const rocket = new Image();
  rocket.src = opts.rocket;

  // Plain and quiet, in the light violet of LFG's site: the rocket, and how to talk to it.
  function draw() {
    ctx.fillStyle = "#ede9fe";
    ctx.fillRect(0, 0, W, H);
    // Everything sits in the middle, so it survives Meet cropping the tile.
    const cx = W / 2, cy = H / 2 - 22;
    if (rocket.complete && rocket.naturalWidth) {
      const size = 250;
      ctx.drawImage(rocket, cx - size / 2, cy - size / 2, size, size);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#4c1d95";
    ctx.font = "500 24px Inter, 'Segoe UI', Roboto, Arial, sans-serif";
    ctx.fillText(opts.hint, cx, cy + 165);
  }
  // A timer, not requestAnimationFrame: the bot's tab is never in front, and the video
  // track only carries frames while the canvas is being painted.
  setInterval(draw, 1000 / FPS);
  draw();

  const cardTrack = () => canvas.captureStream(FPS).getVideoTracks()[0];
  const wantsCard = (video) => !!video;

  const getUserMedia = md.getUserMedia.bind(md);
  md.getUserMedia = async (constraints = {}) => {
    if (!wantsCard(constraints.video)) return getUserMedia(constraints);
    const tracks = [];
    if (constraints.audio) tracks.push(...(await getUserMedia({ audio: constraints.audio })).getAudioTracks());
    tracks.push(cardTrack());
    return new MediaStream(tracks);
  };
  const enumerateDevices = md.enumerateDevices.bind(md);
  md.enumerateDevices = async () => {
    const devices = await enumerateDevices();
    if (devices.some((d) => d.kind === "videoinput" && d.deviceId)) return devices;
    return [...devices, { ...DEVICE, toJSON: () => DEVICE }];
  };
  window.__lfgCard = { canvas };
}
