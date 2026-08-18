// Plain-English reference definitions for SCTE-35 vocabulary and the HLS
// cue tags that carry it, plus small render helpers that turn known values
// into clickable glossary terms.
//
// Security note: decoded SCTE-35 fields can contain attacker-controlled
// bytes (e.g. a UPID is decoded straight from the payload as UTF-8 text).
// glossaryTerm()/linkifyTagLine() only ever wrap a value in a live <span>
// when that exact value is a key in GLOSSARY — a fixed, hardcoded set we
// control — so untrusted payload content can never smuggle in markup; it
// only ever gets escaped and displayed as inert text.

export const GLOSSARY = {
  // splice commands
  splice_null: "A no-op / heartbeat command — carries no splice action, just keeps the cue stream alive.",
  splice_schedule: "Announces one or more splice events in advance, scheduled by time rather than triggering immediately.",
  splice_insert: "The legacy way to signal a single splice point (break start/return) via an event ID and PTS time — mostly superseded by time_signal + segmentation_descriptor.",
  time_signal: "Signals a PTS time without saying what it means on its own — the accompanying segmentation_descriptor(s) supply the actual event details. The most common modern SCTE-35 command.",
  bandwidth_reservation: "Reserves bandwidth for a future splice command; carries no splice information itself.",
  private_command: "A vendor-specific/proprietary payload not defined by the SCTE-35 spec.",

  // segmentation_type_id names
  "Not Indicated": "No specific segmentation type was given.",
  "Content Identification": "Marks a point associated with content identification metadata only.",
  "Program Start": "Start of a program (e.g. a show or movie).",
  "Program End": "End of a program.",
  "Program Early Termination": "The program ends earlier than scheduled.",
  "Program Breakaway": "Content breaks away from the current program (e.g. to local programming) without a formal program end.",
  "Program Resumption": "Programming resumes after a breakaway.",
  "Program Runover Planned": "The current program is running past its scheduled end time, as planned.",
  "Program Runover Unplanned": "The current program is running past its scheduled end time, unplanned.",
  "Program Overlap Start": "A new program starts while the previous one is technically still active.",
  "Program Blackout Override": "A blackout restriction is being overridden for this program.",
  "Program Start - In Progress": "Signals a program start for a viewer joining already in progress.",
  "Chapter Start": "Start of a chapter within a program (e.g. for VOD chapter markers).",
  "Chapter End": "End of a chapter within a program.",
  "Break Start": "Start of a generic break, not necessarily an ad break.",
  "Break End": "End of a generic break.",
  "Opening Credit Start": "Start of a program's opening credits.",
  "Opening Credit End": "End of a program's opening credits.",
  "Closing Credit Start": "Start of a program's closing credits.",
  "Closing Credit End": "End of a program's closing credits.",
  "Provider Advertisement Start": "Start of an ad break sold/controlled by the content provider (e.g. the network).",
  "Provider Advertisement End": "End of a provider ad break.",
  "Distributor Advertisement Start": "Start of an ad break sold/controlled by the distributor (e.g. the streaming platform/MVPD).",
  "Distributor Advertisement End": "End of a distributor ad break.",
  "Provider Placement Opportunity Start": "Start of a single ad avail within a provider ad break — the signal most ad-insertion systems (e.g. MediaTailor) key off of.",
  "Provider Placement Opportunity End": "End of a provider placement opportunity (single avail).",
  "Distributor Placement Opportunity Start": "Start of a single ad avail within a distributor ad break.",
  "Distributor Placement Opportunity End": "End of a distributor placement opportunity.",
  "Provider Overlay Placement Opportunity Start": "Start of a provider-controlled overlay ad opportunity (e.g. a banner, not a full break).",
  "Provider Overlay Placement Opportunity End": "End of a provider overlay placement opportunity.",
  "Distributor Overlay Placement Opportunity Start": "Start of a distributor-controlled overlay ad opportunity.",
  "Distributor Overlay Placement Opportunity End": "End of a distributor overlay placement opportunity.",
  "Provider Promo Start": "Start of a provider-controlled promo (unpaid house ad) segment.",
  "Provider Promo End": "End of a provider promo segment.",
  "Distributor Promo Start": "Start of a distributor-controlled promo segment.",
  "Distributor Promo End": "End of a distributor promo segment.",
  "Unscheduled Event Start": "Start of an event that wasn't part of the planned schedule (e.g. breaking news).",
  "Unscheduled Event End": "End of an unscheduled event.",
  "Alternate Content Opportunity Start": "Start of a window where alternate content (e.g. regional substitution) may be inserted.",
  "Alternate Content Opportunity End": "End of an alternate content opportunity.",
  "Provider Ad Block Start": "Start of a provider-defined block containing multiple ads.",
  "Provider Ad Block End": "End of a provider ad block.",
  "Distributor Ad Block Start": "Start of a distributor-defined block containing multiple ads.",
  "Distributor Ad Block End": "End of a distributor ad block.",
  "Network Start": "Start of network-level (as opposed to program-level) content, e.g. a channel bumper.",
  "Network End": "End of network-level content.",

  // UPID types
  "Not Used": "No UPID is present for this segment.",
  "User Defined": "A UPID whose format is defined by the sender rather than SCTE-35 itself — meaning depends on the provider.",
  ISCI: "Industry Standard Commercial Identifier — a legacy ad identifier format, predecessor to Ad-ID.",
  "Ad-ID": "The industry-standard ad identifier used across the US advertising industry (successor to ISCI).",
  UMID: "Unique Material Identifier — a SMPTE standard ID for media essence/clips.",
  "ISAN (deprecated)": "International Standard Audiovisual Number, legacy encoding — identifies an audiovisual work.",
  ISAN: "International Standard Audiovisual Number — identifies a specific audiovisual work, like an ISBN for video.",
  TID: "Turner Identifier — a legacy content ID format.",
  TI: "Turner Identifier (short form).",
  ADI: "References metadata from a CableLabs ADI (Asset Distribution Interface) package.",
  EIDR: "Entertainment Identifier Registry ID — a universal identifier for movies and TV episodes.",
  "ATSC Content ID": "A content identifier as defined by the ATSC broadcast standard.",
  MPU: "Managed Private UPID — a vendor-managed private identifier format.",
  MID: "Multiple UPID — signals that several UPIDs, each with their own type, follow concatenated together.",
  "ADS Info": "Free-form text intended for an ad decision system, rather than a structured identifier.",
  URI: "The UPID is a URI, e.g. a link to metadata about this segment.",
  UUID: "The UPID is a standard 128-bit UUID.",
  SCR: "Segmentation Content Reference identifier.",

  // delivery mechanism (not part of the splice_info_section format itself)
  "out-of-band SCTE-35": "The splice_info_section payload is exposed in the manifest itself (e.g. HLS's EXT-X-DATERANGE/EXT-X-CUE-OUT/EXT-OATCLS-SCTE35 tags) rather than muxed into the media — just parse the playlist text, no demuxing required. This is the only kind of SCTE-35 this tool can see.",
  "in-band SCTE-35": "The splice_info_section payload is embedded directly in the transport stream (an MPEG-TS private PID, or an emsg/timed-metadata box in fMP4) — a player has to demux the actual media segments to find it. This tool can't see in-band-only cues; a packager that mirrors the same cues out-of-band in the manifest is what makes them visible here.",

  // HLS cue-related tags
  "EXT-X-CUE-OUT": "Marks the start of an ad break (cue-out) in the playlist — where insertion should begin.",
  "EXT-X-CUE-IN": "Marks the end of an ad break (cue-in) — playback returns to the main content here.",
  "EXT-X-CUE-OUT-CONT": "A 'continue' marker repeated on segments inside an ongoing ad break, so a player joining mid-break knows it's still in one.",
  "EXT-X-CUE": "A generic/legacy cue marker tag — implementation-specific, predates the CUE-OUT/CUE-IN convention.",
  "EXT-OATCLS-SCTE35": "A vendor tag carrying the raw base64 SCTE-35 payload alongside cue-out/cue-in info.",
  "EXT-X-SCTE35": "Carries a raw SCTE-35 payload (base64 or hex) directly in the playlist, tied to a splice point.",
  "EXT-X-DATERANGE": "The standard HLS tag for signaling a time range — most modern SCTE-35-in-HLS signaling rides on its SCTE35-OUT/SCTE35-IN/SCTE35-CMD attributes.",
  "EXT-X-ASSET": "Carries asset metadata (e.g. an ad break's ID) associated with a cue, used by some ad-insertion workflows.",

  // HLS EXT-X-MEDIA — alternate renditions (alternate audio, sidecar
  // subtitles, embedded closed captions). Not SCTE-35-related, but the
  // most common thing people staring at a raw manifest need explained.
  "EXT-X-MEDIA": "Declares an alternate rendition of the content — an alternate audio track, sidecar subtitles, or embedded closed captions — associated with a group of video variants via GROUP-ID. This is the tag that carries language info for anything other than the main video.",
  SUBTITLES: "TYPE=SUBTITLES: full sidecar subtitle text, delivered as its own separate playlist and segments (usually WebVTT) — not embedded in the video. Different from CLOSED-CAPTIONS, which rides inside the video segments themselves.",
  "CLOSED-CAPTIONS": "TYPE=CLOSED-CAPTIONS: captions embedded directly inside the video segments (CEA-608/708), not delivered as separate files. INSTREAM-ID says which embedded channel this rendition refers to.",
  AUDIO: "TYPE=AUDIO: an alternate audio rendition — e.g. a different language dub or a commentary track — delivered as its own playlist and segments, selected the same way as an alternate subtitle track.",
  VIDEO: "TYPE=VIDEO: an alternate video rendition. Rare in practice — most HLS streams list their video quality levels via EXT-X-STREAM-INF instead, not as EXT-X-MEDIA renditions.",
  LANGUAGE: "A BCP 47 / RFC 5646 language tag (e.g. en, es-419, fr-CA) identifying the primary language of this rendition.",
  "ASSOC-LANGUAGE": "A second, associated language for this rendition beyond its primary LANGUAGE — e.g. a track that's genuinely mixed-language.",
  "INSTREAM-ID": "For embedded CLOSED-CAPTIONS only — selects which embedded CEA-608 channel (CC1-CC4) or CEA-708 service (SERVICE1-63) this rendition refers to, since captions for several languages can be multiplexed into the same video segments.",
  AUTOSELECT: "Tells the player it's reasonable to automatically enable this rendition based on the viewer's system language/accessibility settings, without them explicitly picking it.",
  DEFAULT: "Marks this as the rendition a player should enable automatically if it isn't applying any other selection logic.",
  FORCED: "Subtitles only: marks a track that should display even when the viewer has subtitles turned off — used for burned-in-style translation of foreign-language dialogue, not general accessibility captioning.",
  "GROUP-ID": "Groups this alternate rendition with the video variants (in EXT-X-STREAM-INF) that reference the same GROUP-ID — how the player knows which audio/subtitle/caption options belong with which quality level.",
  CHARACTERISTICS: "Accessibility/content-nature hints (e.g. public.accessibility.describes-video) describing what a rendition is for, beyond just its language.",

  // DASH equivalents — captions/subtitles/language signaling
  Role: "Labels what a DASH AdaptationSet is for — main content, subtitle, caption, commentary, dub, description (audio description), etc. — via its value attribute.",
  Accessibility: "Flags a DASH AdaptationSet as serving an accessibility purpose — e.g. CEA-608/708 closed captions embedded in the stream, or audio description — via a schemeIdUri identifying the accessibility type.",
  subtitle: "Role value: this AdaptationSet carries sidecar subtitle text, not captions embedded in the video.",
  caption: "Role value: this AdaptationSet carries captions intended for viewers who can't hear the audio — as opposed to a foreign-language subtitle translation.",
  description: "Role value: this AdaptationSet is an audio description track — a narrated description of on-screen action for blind/low-vision viewers.",
  commentary: "Role value: this AdaptationSet is a commentary track, not the main program audio.",
  dub: "Role value: this AdaptationSet is a dubbed-language version of the main audio.",
  main: "Role value: this AdaptationSet is the primary program content, as opposed to an alternate/commentary/description track.",
  lang: "A BCP 47 language tag (e.g. en, es-419, fr-CA) on a DASH AdaptationSet identifying its language — the DASH equivalent of HLS's LANGUAGE attribute.",

  // hls.js ErrorTypes — the broad category each error falls under.
  networkError: "Something failed while fetching a manifest, segment, or key over the network — a download problem, not a decode problem.",
  mediaError: "The browser's Media Source Extensions (MSE) pipeline rejected or choked on data after it was downloaded — a decode/buffering problem, not a network problem.",
  keySystemError: "An EME/DRM operation failed — acquiring a license, updating a session, or the CDM itself refused something.",
  muxError: "hls.js's own remuxer (repackaging the downloaded segment into something MSE accepts) failed.",
  otherError: "Doesn't fit the other categories — often an internal error or a problem attaching to the <video> element itself.",

  // hls.js ErrorDetails — manifest/level/track loading.
  manifestLoadError: "The master/media playlist itself failed to download (network failure, DNS, CORS, or a non-2xx HTTP status).",
  manifestLoadTimeOut: "The playlist request took too long and hls.js gave up waiting.",
  manifestParsingError: "The playlist downloaded fine but isn't valid HLS — malformed tags, wrong content, or not an .m3u8 at all.",
  manifestIncompatibleCodecsError: "Every variant in the playlist declares a codec this browser can't play — the manifest is fine, the codec choice isn't.",
  levelEmptyError: "A rendition's playlist was parsed but contains zero usable segments.",
  playlistUnchangedError: "A live playlist hasn't changed across several consecutive refreshes — the origin may have stalled.",
  levelLoadError: "A specific rendition's (variant's) media playlist failed to download.",
  levelLoadTimeOut: "A specific rendition's media playlist request timed out.",
  levelParsingError: "A specific rendition's media playlist downloaded but isn't valid HLS syntax.",
  levelSwitchError: "Switching to a different quality rendition failed partway through.",
  audioTrackLoadError: "An alternate audio track's playlist failed to download.",
  audioTrackLoadTimeOut: "An alternate audio track's playlist request timed out.",
  subtitleTrackLoadError: "A subtitle track's playlist failed to download.",
  subtitleTrackLoadTimeOut: "A subtitle track's playlist request timed out.",

  // hls.js ErrorDetails — segment/key loading.
  fragLoadError: "A media segment failed to download.",
  fragLoadTimeOut: "A media segment request took too long and was abandoned.",
  fragDecryptError: "An encrypted segment downloaded fine but failed to decrypt (bad key, wrong IV, or a corrupted segment).",
  fragParsingError: "A segment downloaded but its contents are corrupt or don't match what the container format expects.",
  fragGap: "hls.js skipped a segment because the playlist explicitly marked it as a gap (no content available there).",
  keyLoadError: "The decryption key file itself failed to download.",
  keyLoadTimeOut: "The decryption key request took too long and was abandoned.",

  // hls.js ErrorDetails — buffer / MediaSource (the category bufferAppendNoProgress belongs to).
  bufferAddCodecError: "The browser refused to create a SourceBuffer for one of the stream's codecs — usually means this browser can't decode that codec at all.",
  bufferIncompatibleCodecsError: "The audio and video codecs can't both be buffered together in this browser's MSE implementation.",
  bufferAppendError: "Handing decoded segment data to the browser's buffer threw an error outright.",
  bufferAppendingError: "A segment append attempt failed; hls.js will retry a limited number of times before treating it as fatal.",
  bufferAppendNoProgress: "A segment was accepted by the buffer with no error, but didn't actually add any playable time — often a codec/timestamp mismatch the browser silently rejected. Non-fatal by default; hls.js logs it and moves on unless it keeps happening.",
  bufferStalledError: "Playback hit the end of buffered data and had to pause — a rebuffer, not a hard failure.",
  bufferFullError: "The browser's media buffer is full and can't accept more data until some is evicted.",
  bufferSeekOverHole: "A seek landed in a gap with no buffered data; hls.js is waiting for that region to load.",
  bufferNudgeOnStall: "hls.js nudged the playback position slightly to break out of a stall caused by a small gap in buffered data.",
  remuxAllocError: "hls.js's remuxer failed to allocate memory while repackaging a segment.",

  // hls.js ErrorDetails — key system / DRM.
  keySystemNoKeys: "No usable decryption keys were found for this content.",
  keySystemNoAccess: "The browser denied access to the requested DRM system (EME) entirely.",
  keySystemNoSession: "No active DRM session exists to apply a key or license to.",
  keySystemNoConfiguredLicense: "hls.js needs a license-server URL for this DRM system but none was configured.",
  keySystemLicenseRequestFailed: "The request to the DRM license server failed.",
  keySystemServerCertificateRequestFailed: "Fetching the DRM server certificate failed.",
  keySystemServerCertificateUpdateFailed: "The browser rejected the DRM server certificate it was given.",
  keySystemSessionUpdateFailed: "The DRM session refused the license/key data it was given.",
  keySystemStatusOutputRestricted: "The DRM license was granted but restricts output (e.g. blocks playback without HDCP) in a way this setup can't satisfy.",
  keySystemStatusInternalError: "The DRM system (CDM) itself reported an internal error.",
  keySystemDestroyMediaKeysError: "Cleaning up DRM media keys during teardown failed (usually harmless).",
  keySystemDestroyCloseSessionError: "Closing a DRM session during teardown failed (usually harmless).",
  keySystemDestroyRemoveSessionError: "Removing a DRM session during teardown failed (usually harmless).",

  // hls.js ErrorDetails — everything else.
  internalException: "An unexpected error occurred inside hls.js itself while handling an event.",
  aborted: "An in-progress load was deliberately cancelled (e.g. because playback was stopped) — not a real failure.",
  attachMediaError: "hls.js failed to attach itself to the <video> element.",
  mediaSourceRequiresReset: "The browser's MediaSource object entered a state where hls.js has to reinitialize it before continuing.",
  unknown: "hls.js couldn't categorize this error.",
};

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Wraps `value` as a clickable glossary term when we have a definition for
// it, otherwise just escapes it. Safe to call with untrusted strings — see
// the file-level note above.
export function glossaryTerm(value) {
  const label = escapeHtml(value);
  if (Object.prototype.hasOwnProperty.call(GLOSSARY, value)) {
    return `<span class="glossary-term" data-term="${escapeHtml(value)}">${label}</span>`;
  }
  return label;
}

// Longest-first so "EXT-X-CUE-OUT-CONT" is matched before the "EXT-X-CUE-OUT"
// prefix it contains (and that before the bare "EXT-X-CUE" prefix).
const HLS_TAG_NAMES = [
  "EXT-X-CUE-OUT",
  "EXT-X-CUE-IN",
  "EXT-X-CUE-OUT-CONT",
  "EXT-X-CUE",
  "EXT-OATCLS-SCTE35",
  "EXT-X-SCTE35",
  "EXT-X-DATERANGE",
  "EXT-X-ASSET",
  "EXT-X-MEDIA",
].sort((a, b) => b.length - a.length);

// Wraps known fixed vocabulary found *inside* a line — HLS EXT-X-MEDIA's
// TYPE enum and attribute names, plus DASH's Role/Accessibility elements
// and lang attribute — against text that has ALREADY been through
// escapeHtml(). Safe because every token matched here is plain ASCII
// (letters/hyphens/"="), which escapeHtml leaves byte-for-byte unchanged,
// so this never runs against raw untrusted markup — only ever against
// already-inert text, in which it can only find (and wrap) the exact fixed
// strings it's looking for.
function linkifyInlineTokens(escapedText) {
  return escapedText
    // HLS EXT-X-MEDIA TYPE=... (unquoted enumerated-string per spec)
    .replace(/\bTYPE=(SUBTITLES|CLOSED-CAPTIONS|AUDIO|VIDEO)\b/g, (m, val) => `TYPE=${glossaryTerm(val)}`)
    // HLS EXT-X-MEDIA attribute names — value (quoted or not) is left alone
    .replace(
      /\b(LANGUAGE|ASSOC-LANGUAGE|INSTREAM-ID|AUTOSELECT|DEFAULT|FORCED|GROUP-ID|CHARACTERISTICS)=/g,
      (m, name) => `${glossaryTerm(name)}=`
    )
    // DASH element names (escaped "<" is "&lt;")
    .replace(/&lt;(Role|Accessibility)\b/g, (m, el) => `&lt;${glossaryTerm(el)}`)
    // DASH Role value="..." (escaped quotes are "&quot;")
    .replace(
      /value=&quot;(subtitle|caption|description|commentary|dub|main)&quot;/g,
      (m, val) => `value=&quot;${glossaryTerm(val)}&quot;`
    )
    // DASH lang="..." attribute name — value is left alone
    .replace(/\blang=(?=&quot;)/g, () => `${glossaryTerm("lang")}=`);
}

// Escapes a manifest line (HLS tag line or DASH XML line), linkifying the
// leading "#TAG-NAME" token against the fixed whitelist above when present,
// plus any inline vocabulary from linkifyInlineTokens — never the
// attribute/attacker-controlled values themselves, which stay inert
// escaped text throughout.
export function linkifyTagLine(line) {
  for (const tag of HLS_TAG_NAMES) {
    if (line.startsWith(`#${tag}`)) {
      return `#${glossaryTerm(tag)}${linkifyInlineTokens(escapeHtml(line.slice(1 + tag.length)))}`;
    }
  }
  return linkifyInlineTokens(escapeHtml(line));
}
