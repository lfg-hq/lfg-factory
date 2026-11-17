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
  // 720p, the most Meet sends, so nothing is stretched. A steady 15 frames a second gives the
  // encoder frames to sharpen a still picture on, and costs little when nothing changes.
  const W = 1280, H = 720, FPS = 15;
  const DEVICE = { deviceId: "lfg-card", groupId: "lfg-card", kind: "videoinput", label: "LFG" };

  // Nothing happens until Meet asks for the camera. Loading an image while the page is still
  // loading stalled Meet (it never finished loading), so the rocket is decoded straight from
  // its bytes, and only then.
  let canvas = null;
  function start() {
    if (canvas) return canvas;
    canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    let rocket = null;
    const bytes = Uint8Array.from(atob(opts.rocket.split(",")[1] || ""), (c) => c.charCodeAt(0));
    createImageBitmap(new Blob([bytes], { type: "image/png" })).then((bitmap) => { rocket = bitmap; }, () => {});

    // Plain and quiet, in the light violet of LFG's site: the rocket, and how to talk to it.
    const draw = () => {
      ctx.fillStyle = "#ede9fe";
      ctx.fillRect(0, 0, W, H);
      // Everything sits in the middle, so it survives Meet cropping the tile.
      const cx = W / 2, cy = H / 2 - 30;
      if (rocket) {
        const size = 340;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(rocket, cx - size / 2, cy - size / 2, size, size);
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#4c1d95";
      ctx.font = "500 32px Inter, 'Segoe UI', Roboto, Arial, sans-serif";
      ctx.fillText(opts.hint, cx, cy + 222);
    };
    // A timer, not requestAnimationFrame: the bot's tab is never in front, and the video
    // track only carries frames while the canvas is being painted.
    setInterval(draw, 1000 / FPS);
    draw();
    return canvas;
  }

  const cardTrack = () => {
    const track = start().captureStream(FPS).getVideoTracks()[0];
    // A still picture with text: tell the encoder to keep detail sharp rather than smooth motion.
    track.contentHint = "detail";
    return track;
  };
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
  window.__lfgCard = { start };
}
