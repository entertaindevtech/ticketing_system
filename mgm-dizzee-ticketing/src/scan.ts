// Gate-scanner helpers: QR detection and camera handling. The browser only reads the QR text; whether a ticket is
// admitted is always decided by the server (POST /api/gate/scan).

export type ScanKind = "valid" | "duplicate" | "invalid";
/** What the gate screen shows. "cancelled" is an invalid result the server explained as a cancellation. */
export type Outcome = ScanKind | "cancelled";
export const outcome = (r: { kind: ScanKind; reason: string; status?: string }): Outcome =>
  r.kind === "invalid" && (r.status ? r.status === "CANCELLED" : /cancel/i.test(r.reason)) ? "cancelled" : r.kind; // status: servers since group admission

/** Booking QRs (signed MGMBK1) and typed booking references open group admission; everything else is a ticket. */
export const isBookingCode = (raw: string) => { const c = raw.trim().toUpperCase(); return c.startsWith("MGMBK1|") || /^MGM-[A-Z0-9]{4,12}$/.test(c); };

export type CamProblem = "unsupported" | "denied" | "nocamera" | "busy";
export const CAM_MESSAGES: Record<CamProblem, string> = {
  unsupported: "Camera scanning isn't available in this browser. Type the ticket ID below.",
  denied: "Camera access was blocked. Allow the camera for this site in your browser settings, or type the ticket ID below.",
  nocamera: "No camera was found on this device. Type the ticket ID below.",
  busy: "The camera is being used by another app. Close it and try again, or type the ticket ID below.",
};
/** Maps a getUserMedia failure (a DOMException name) to what the gate screen tells staff. */
export function camProblem(e: unknown): CamProblem {
  const n = (e as { name?: string })?.name;
  if (n === "NotAllowedError" || n === "SecurityError") return "denied";
  if (n === "NotFoundError" || n === "OverconstrainedError" || n === "DevicesNotFoundError") return "nocamera";
  if (n === "NotReadableError" || n === "TrackStartError" || n === "AbortError") return "busy";
  return "unsupported";
}

export type Detector = { detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
let detector: Promise<Detector> | null = null;
/** The native BarcodeDetector where it reads QR codes (Chrome on Android); elsewhere (iOS Safari, Firefox) the
 *  ZXing WebAssembly polyfill, loaded on first use and served from this app — no CDN. */
export function getDetector(): Promise<Detector> {
  return (detector ??= (async () => {
    type BD = { new (o: object): Detector; getSupportedFormats?: () => Promise<string[]> };
    const Native = (window as unknown as { BarcodeDetector?: BD }).BarcodeDetector;
    if (Native && ((await Native.getSupportedFormats?.().catch(() => [])) ?? []).includes("qr_code")) return new Native({ formats: ["qr_code"] });
    const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
      import("barcode-detector/ponyfill"), import("zxing-wasm/reader/zxing_reader.wasm?url")]);
    // Await the WebAssembly load so a failure shows "camera scanning unavailable" instead of a silent scanner.
    await prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) }, fireImmediately: true });
    return new BarcodeDetector({ formats: ["qr_code"] }) as unknown as Detector;
  })().catch((e) => { detector = null; throw e; }));
}

/** Opens a camera: the given one, otherwise the rear camera where there is one. */
export function openCamera(deviceId?: string): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error("unsupported"));
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
}

/** Short confirmation tone; staff can switch it off. */
export function beep(ok: boolean) {
  try {
    const A = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new A(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220; o.type = ok ? "sine" : "square"; g.gain.value = 0.15;
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (ok ? 0.15 : 0.4));
    o.onended = () => void ctx.close();
  } catch { /* no audio */ }
}
