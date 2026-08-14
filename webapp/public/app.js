import { decodeScte35, formatDecoded, parseScteInput } from "./scte35.js";

const $ = (id) => document.getElementById(id);

$("decode-btn").addEventListener("click", () => {
  const raw = $("decode-input").value;
  const out = $("decode-output");
  out.innerHTML = "";
  if (!raw.trim()) return;
  try {
    const bytes = parseScteInput(raw);
    const decoded = decodeScte35(bytes);
    const lines = [`bytes        : ${bytes.length}`, ...formatDecoded(decoded, "")];
    out.innerHTML = lines.join("\n");
  } catch (e) {
    out.textContent = `Decode error: ${e.message}`;
  }
});
