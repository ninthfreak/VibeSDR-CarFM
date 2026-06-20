/**
 * AboutOverlay — full-screen "About VibeSDR" page (opened from the menu
 * footer). What's new in V4, full credits for everything borrowed or built
 * on, and the GPL-3.0 licence statement. Pure native scroll view styled to
 * match BrowserOverlay's bar + the a11y menu skin.
 */

import React from 'react';
import {
  Image, Linking, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { APP_VERSION } from '../constants/version';

export interface AboutOverlayProps {
  visible: boolean;
  onClose: () => void;
}

// Stuart's personal message — source: reference/VibeSDR About.rtf (proofread,
// voice preserved; V1-era references updated for V2).
const STUEY_URL = 'https://stuey3d.tunnel.ubersdr.org/';
const STUART_MESSAGE: string[] = [
  'Hi, my name is Stuart (Stuey3D) and I am the UI designer and tester for this project.',
  "VibeSDR came about from the frustration of trying to use extremely powerful WebSDR servers on mobile devices, only to be served a broken website that wasn't optimised for mobile and tried to fit the entire desktop site onto a phone screen. I'd had an idea for a mobile-optimised SDR interface for a while, but I am not a developer and I don't know how to code, so I had no way of realising my UI ideas.",
  "After some back and forth with M9PSY, the creator of the amazing UberSDR web SDR software, he made a basic mobile web UI for UberSDR — some desktop assets reused and repositioned for mobile — but most of UberSDR's cool features, such as the decoders and maps, were still not available to users. I had helped M9PSY test various features over the previous few weeks and suggested new ones, and he encouraged me to make my own add-ons for UberSDR, since it already had sections where a user could add their own code for info banners or badges. I told him I was no coder, but he said just get AI to do it — I was good at testing and providing feedback, and that's all the AI needed.",
  "A bit sceptical, I started by getting ChatGPT to create a simple PSKReporter tracking badge, which grew to be quite sophisticated with all sorts of stats tracking and graphs. I was amazed at how quickly I got it to such an advanced level — even though with ChatGPT you'd fix one thing and break ten others, so many hours were spent testing everything. During this time, at my suggestion, M9PSY added a widget gallery to UberSDR that lets a user add up to ten widgets to their page — so my PSKR badge was suddenly a widget any UberSDR instance owner could install at the click of a button.",
  'I was so excited about my progress with the PSKR badge that I chatted to M9PSY about it, and he said: "I\'ll let you into a little secret — Claude is better."',
  "So with that knowledge I embarked on my next widget: a search bar for the bookmarks, as at the time UberSDR lacked a bookmark search feature. Guessing M9PSY was probably fed up with me badgering him for new features, I decided to build my own bookmark search (which is part of this app too). It turned out very well, so I showed it off to M9PSY — who said he had already built a bookmark search but hadn't enabled it yet. That being said, I asked whether his refreshed dynamically during a session, as the EiBi bookmarks change with station schedules. His loaded once on page load and that was it — so my search bar had more functionality, having discovered the dynamic bookmarks early.",
  'M9PSY kept encouraging me and explained that a widget is HTML code that loads last and can be very powerful — even removing the entire UI and replacing it. Interesting, I thought: maybe Claude and I could build a UI skin that would make controlling UberSDR better.',
  'Over 500 builds of the UI — which I dubbed Pocket UberSDR at the time — Claude and I managed to get around 90–95% of the full UberSDR desktop functionality running in a mobile-optimised interface. We got most of the radio decoders working on-device, plus viewers for the on-server add-ons such as Digital Spots, CW Spots and HFDL aircraft tracking. I even beat M9PSY to getting server-side noise reduction working on mobile.',
  'That UI was a labour of love, with many late nights and early mornings spent testing on multiple devices and reporting back, and it became what I truly believe to be the ultimate mobile SDR interface. M9PSY openly admits he is old skool and doesn\'t really use mobile devices, so mobile was much lower down his priority list for UberSDR. Armed with my new confidence, and with Claude by my side, I like to think I successfully saved him a job.',
  "One big issue remained: my UI was an optional skin/widget for UberSDR, and for everybody to be able to use it, individual instance owners would need to add it to their servers. I felt a little deflated — most users set up their instances, forget them, and leave them running without even adding the cool new features M9PSY has been building (such as 24/7 server-side WEFAX/SSTV/NAVTEX decoding), so what chance did my UI have if server owners wouldn't add it? And then it hit me: I'll make an app I can share directly with users. Like Thanos, I thought \"Fine, I'll do it myself\" — and the app you are using is the result of that thought.",
  'When you load the app you are taken to the instance list, where you can set a default that loads straight away (ideal for instance owners, or if you simply have a favourite). And regardless of whether the instance owner has added my UI to their server, you get the full mobile-optimised interface — tested all the way down to a 4-inch screen (iPhone SE in Display Zoom mode).',
  "I am extremely proud of this app. It has been a labour of love and a lot of testing — but I am simply one man with no coding experience, just a vision and a tool (Claude) to realise that vision. I also believe in openness and honesty, and I will never hide the fact that this app was coded with AI — which is why it is called VibeSDR, to really lean into the vibe-coding aspect of it. I know some people do not like AI, due to its resource usage and the amount of slop posted daily on social media. For me, I would not feel happy sharing this app if I hadn't tested it as much as one man can, and the name VibeSDR was chosen so that people who are anti-AI can choose not to use this app if they feel that's right for them.",
  "Is this app perfect? Probably not. Will there be bugs? Yeah, probably. I have genuinely spent hours upon hours testing, and a lot of time fixing tiny things like alignment issues that would have been \"good enough\" — but I wanted them perfect. I really hope that when you use this app you can see the thought and love that have gone into it, and that everything is laid out logically.",
  "Well, that's it — my app-creation history laid out bare. I hope you enjoy this app as much as I enjoyed making it.",
];

const VERSION_HISTORY: { v: string; detail: string }[] = [
  { v: 'V1', detail: 'Initial version — UberSDR support only, using the server-provided waterfall and spectrum.' },
  { v: 'V2', detail: "Fully native rewrite with a custom GPU waterfall/spectrum stack (V1's headline future plan, delivered), native audio with background playback and media controls, on-device decoders, chat, bookmarks and much more — see What's New above." },
  { v: 'V2.0.1', detail: 'Bug fixes: bandwidth sliders now match the server’s 6 kHz limit (were going to 8 kHz), and bookmark/band-plan search shows the full result list in a scrollable dropdown (previously capped at 25 results, so higher bands like 20m were cut off).' },
  { v: 'V2.1', detail: 'In-car upgrades: Android Auto now shows browsable Bookmarks and Band Plan lists (tap to tune), not just skip buttons. Band-aware tuning sets the right demodulator and step for each band — applied when you pick a band from the search list, and automatically as you cross band edges while connected to a car (handheld tuning is never changed automatically). CarPlay browsing is ready for when the entitlement is in place.' },
  { v: 'V2.1.1', detail: 'Band-aware mode/step now also applies to remote tuning — lock screen, Apple Watch and connected headphones — not just the car. It still stays out of your way while you’re hands-on tuning with the VFO drum on the waterfall.' },
  { v: 'V2.1.2', detail: 'Band-aware tuning tweaks: utility and beacon (NDB) ranges now default to USB / 500 Hz, and the 11m CB band follows the receiver’s ITU region — NFM in Europe/Asia-Pacific, AM in the Americas.' },
  { v: 'V2.1.3', detail: 'Media-control skips (lock screen, Apple Watch, Android Auto, headphones) now snap to the step grid like the VFO drum — so skipping from an off-grid frequency lands on a clean multiple of the step rate.' },
  { v: 'V2.1.4', detail: 'Fixes a frozen waterfall when returning to the app after another audio app suspended it (it now reconnects on its own). Adds a Data Saver: after a chosen spell muted — lock screen, AirPods out, or pause — the SDR stream disconnects to stop wasting data and battery. Pick the timeout under Power Saving (Off / Instant / 5–30 min); the media controls show a countdown, then “Open App to Resume”, and Play reconnects.' },
  { v: 'V2.1.6', detail: 'Data Saver moved to the main menu (under Controls). Pause now genuinely pauses on iOS — the lock-screen button no longer springs back to play, and the app stops grabbing shared AirPods from a Mac while paused. The Admin section is now labelled “Instance Admin”.' },
  { v: 'V2.1.7', detail: 'When another app takes over audio (e.g. a Mac grabbing your shared AirPods, or another media app on the phone), VibeSDR now registers it as a mute — the muted banner shows and the Data Saver countdown starts — instead of silently sitting connected. Works on both iOS and Android now. Press Play to come back.' },
  { v: 'V2.1.8', detail: 'The album art now reflects state at a glance: the server-logo corner becomes a muted-speaker with the minutes-to-disconnect while paused, and a disconnected icon once the Data Saver drops the stream.' },
  { v: 'V2.1.9', detail: 'Resuming after a Data Saver disconnect now does a full from-scratch reconnect (new session) instead of reopening the old one — fixes the frozen waterfall / dead-audio state that previously needed a trip back to the instance list.' },
  { v: 'V2.1.10', detail: 'Data Saver polish: while paused the media controls show a static “auto-disconnect at HH:MM to save data & power”, and once it disconnects the controls are released entirely (no half-working Play button). Reopening the app fully reconnects and unmutes.' },
  { v: 'V2.1.11', detail: 'Simpler pause/play: pause now disconnects and play reconnects (the server lets the session go on suspend anyway, and reconnecting is near-instant) — no more mute timeout or countdown. The media card shows a clear Disconnected state, and a “Failed to reconnect — open VibeSDR” state with an ⚠️ if the server is full or busy. Also fixes the SNR meter drifting with zoom level (the noise floor is now measured zoom-independently; dBFS and S-meter were already fine).' },
  { v: 'V2.1.12', detail: 'SNR meter now reads radiod’s channel SNR (baseband power − noise density) straight from the audio stream — the demodulator’s own measurement of the tuned channel — so it’s accurate against the local noise floor and completely independent of the waterfall zoom. (Corrected for radiod’s +30 dB audio-floor offset, so it stays honest 0–50 dB rather than the inflated 30–80 dB.)' },
  { v: 'V2.2', detail: 'Siri voice control (iOS). Say "Hey Siri, tune VibeSDR" — Siri asks what — then a frequency (7.150 MHz / 7150 kHz / 7151.5), a station ("Radio Caroline"), or a band ("40m ham", "CB"). It tunes with the right demodulator + step, honouring any spoken mode. When a name matches several bookmarks (e.g. "Radio 5") Siri reads the frequencies and you pick by voice; "China Radio at 11 MHz" narrows the list. Also "change VibeSDR mode" → AM / SAM / synchronous AM / LSB / lower side band / …, and "set VibeSDR step rate" → 100 Hz, 9 kHz, … It runs in the background while VibeSDR is playing, so it works over headphones / CarPlay / the lock screen without unlocking. (Tuning is a two-step ask-and-answer — Apple only allows a value inside a one-shot Siri phrase for fixed lists. Android’s in-car answer stays the Android Auto Bookmarks/Band-Plan browse — Google Assistant needs Play Store publishing.)' },
  { v: 'V2.2.1', detail: 'In-car fix: a Siri voice command interrupts the car audio session, which paused and disconnected VibeSDR — it then sat dead until you pressed Play. It now auto-resumes (reconnects on the new frequency) the moment Siri finishes, with no manual Play. A genuine takeover by another app (e.g. a Mac grabbing your AirPods) still waits for Play, as before.' },
  { v: 'V2.2.2', detail: 'Store-readiness pass: clearer location prompt (it’s only for sorting/filtering instances by distance, and denying it changes nothing else); removed two unused Android permissions (microphone and draw-over-other-apps); added a privacy policy and an App Store distribution exception to the GPL licence. No functional changes.' },
  { v: 'V3', detail: 'Multi-backend release — VibeSDR now speaks three SDR server protocols (UberSDR, OpenWebRX/OpenWebRX+ and KiwiSDR) behind the same interface, with a new directory chooser in the instance picker. (KiwiSDRs have very few slots, so owners choose who connects — some refuse apps or block broadcast bands. A refusal or sudden drop is the owner\'s restriction, not a fault in VibeSDR.)' },
  { v: 'V4', detail: 'Local SDR hardware — VibeSDR now runs a radio on-device. Plug an RTL-SDR into an Android phone over USB (“Local Hardware”), or connect to a networked rtl_tcp server from either platform, and the app demodulates AM/SSB/CW/NFM/WFM itself with a bundled on-device DSP core — full waterfall, drum, audio and decoders, with a hardware-control submenu. Adds an MMSE noise-reduction engine and an adaptive Auto Notch (on every backend), plus a client-side dBFS squelch for KiwiSDR. (V5 later replaced that DSP core with VibeSDR’s own clean-room engine.) See What\'s New above.' },
  { v: 'V5', detail: 'New on-device DSP engine — SDR++ Brown (and FFTW and VOLK) have been REMOVED and replaced with VibeDSP, VibeSDR\'s own clean-room, GPL-free signal-processing engine for Local Hardware and RTL-TCP. It is hand-optimised with ARM NEON SIMD throughout, so it runs noticeably cooler and lighter on the battery — especially on low-end phones and tablets — while matching the old engine. It also brings real improvements: true single-sideband SSB (proper image rejection, not double-sideband), genuine FM stereo with a 19 kHz pilot PLL + RDS, a per-channel audio AGC for SSB/CW, working de-emphasis (50/75 µs), a reliable stereo indicator and a force-mono switch. See What\'s New above.' },
];

const FUTURE_PLANS: string[] = [
  'There’s no fixed roadmap from here — V4 delivered the big one (local SDR hardware) and V5 replaced its engine with VibeSDR’s own GPL-free DSP. Ongoing work is polish, more decoders and more backends as they come. If general USB SDR access ever lands on iOS, the on-device engine is already cross-platform (it powers RTL-TCP on iPhone today), so Local Hardware would follow.',
];

const V5_CHANGES: string[] = [
  'SDR++ Brown, FFTW and VOLK are gone — the on-device radio (Local Hardware + RTL-TCP) now runs on VibeDSP, VibeSDR’s own clean-room DSP engine, written from scratch and free of any GPL third-party DSP',
  'Hand-optimised with ARM NEON SIMD across every hot path (FFT, filters, demodulators, resampler, IQ conversion) — runs cooler and uses less battery, especially on low-end phones/tablets',
  'True single-sideband SSB with proper image rejection (the Weaver method) — the wrong sideband is now silent, not bleeding through',
  'Genuine FM stereo: a 19 kHz pilot PLL with smooth stereo blend, a reliable stereo indicator, RDS station name/RadioText, and a force-mono switch for weak signals',
  'Audio AGC for AM/SSB/CW (steady level, no fading or crackle) and working FM de-emphasis (50 µs / 75 µs / off)',
];

const V4_CHANGES: string[] = [
  'Local SDR hardware (Android): plug an RTL-SDR into your phone over USB and pick “Local Hardware” — VibeSDR runs the radio on-device with a bundled DSP core, with the same waterfall, drum, audio and decoders as any remote server, plus a hardware-control submenu (gain, PPM, bias-T, AGC, sample rate, direct sampling)',
  'RTL-TCP (iOS + Android): connect to a networked rtl_tcp server by host:port, with saveable named favourites — the same on-device demodulation, so it works on iPhone too',
  'On-device demodulation of AM / SSB / CW / NFM / WFM with offset tuning (no zero-IF DC-spike break-up on AM)',
  'MMSE noise reduction for local sources: a much stronger spectral denoiser than before (strength 0–20)',
  'Auto Notch on every backend: an adaptive filter that removes steady carriers / heterodynes while leaving voice intact',
  'KiwiSDR: a client-side dBFS squelch, the SNR meter retired (no Kiwi feed), and clearer messaging when an owner restricts access',
];

const V3_CHANGES: string[] = [
  'OpenWebRX / OpenWebRX+ support: waterfall, audio (incl. WFM HD), profile auto-switching, server-gated modes (WFM/DMR/DStar/DAB…), squelch + noise-reduction sliders, basic text chat, and server-side decoders (RTTY, SSTV, FAX, Packet, POCSAG/FLEX, ADS-B, ISM, Meshtastic/Meshcore/LoRa…)',
  'KiwiSDR support: waterfall, audio, tuning, real dBm S-meter, server-side zoom and a live connection meter — same custom interface as every other backend. (Owners choose who connects: some refuse apps or block broadcast bands, so a server may refuse or drop you — that\'s the owner\'s restriction, not VibeSDR.)',
  'New directory chooser in the instance picker: Favourites/Default pinned on top, then UberSDR, Receiverbook (OpenWebRX + KiwiSDR) and the KiwiSDR network — with type logos, user counts and full receivers greyed out',
  'Custom server URLs auto-detect the backend (UberSDR / OpenWebRX / KiwiSDR)',
  'Crash hardening: a flaky server can no longer take the app down — you are returned to the server list with a clear, server-attributed message',
  'Swipe-up-to-minimise no longer knocks the tuning off',
  'Menu footer shows the connected backend’s logo and software version',
];

const V2_CHANGES: string[] = [
  'GPU waterfall — Skia runtime shader with in-shader temporal line synthesis',
  'Full UberSDR skin parity: server maps (HFDL/digi/CW), spots tables, stats and legends',
  'Native audio engines on iOS and Android (Opus over WebSocket, background playback)',
  'Client noise reduction: NR, NR2 and noise blanker, processed on-device',
  'Server-side NR with dynamic filter list and live parameter control',
  'AAC audio recorder with share sheet',
  'Voice Tuning System (VTS): station/band announcements, bookmark skipping and search',
  'User bookmarks — per-instance or global, UberSDR-compatible import/export',
  'Live chat with user list, mute, zoom-sync and tune-sync',
  'Media session: lock-screen/watch/car controls with tune-step or bookmark skip',
  'Admin pages in-app (Admin / Noise Floor / Band Conditions / Listeners)',
  'Spectrum backdrop image with opacity control and station ID overlay',
  'VFO glow and frost controls, signal-meter modes, S-meter calibration',
  'Instance picker: location-aware sorting, country flags, favourites, defaults',
  'Share tuned station as a tappable deep link',
  'Haptic tuning feedback and ProMotion 120 Hz rendering',
];

const CREDITS: { name: string; detail: string }[] = [
  { name: 'M9PSY (madpsy) — UberSDR',
    detail: 'The biggest thank-you of all. M9PSY got me into AI-assisted coding and encouraged this whole project into existence — without him there is no VibeSDR. UberSDR is the server this client is built for, and the on-device decoders (RTTY / NAVTEX, WEFAX, SSTV and more) for Local Hardware and KiwiSDR are based on his UberSDR decoders. Also: the protocol, web-UI design reference, NR2 / noise-blanker / WebSDR-NR DSP algorithms, colour palettes, band plans, bookmark format and the waterfall smoothing pipeline. Cheers, mate.' },
  { name: 'ka9q-radio — Phil Karn, KA9Q',
    detail: 'The SDR engine (radiod) underneath UberSDR.' },
  { name: 'SDR++ & SDR++ Brown — Alexandre Rouma & contributors',
    detail: 'VibeSDR’s original on-device radio (V4) was built on the SDR++ Brown DSP core to get Local Hardware and RTL-TCP up and running quickly. In V5 that was replaced with VibeDSP — VibeSDR’s own clean-room, GPL-free engine — and all SDR++ Brown code was removed; none is bundled now. Some waterfall colour palettes also originate here. Thank you for making on-device SDR possible. Licensed under the GNU GPL v3.' },
  { name: 'librtlsdr & rtl_tcp — Osmocom / Steve Markgraf, and the RTL-SDR Blog fork',
    detail: 'The RTL-SDR USB driver and the rtl_tcp protocol behind the Local Hardware and RTL-TCP backends.' },
  { name: 'KissFFT — Mark Borgerding (BSD-3)',
    detail: 'The small, permissively-licensed FFT kernel inside VibeDSP, used for the on-device waterfall/spectrum.' },
  { name: 'Zstandard — Yann Collet / Meta',
    detail: 'Compression used inside the bundled DSP core.' },
  { name: 'KISS FFT — Mark Borgerding',
    detail: 'The compact FFT behind the MMSE noise reduction, Auto Notch and on-device decoders.' },
  { name: 'ft8_lib — Karlis Goba, YL3JG',
    detail: 'FT8 / FT4 decoding for the on-device digital-mode decoders.' },
  { name: 'OpenWebRX — Jakob Ketterl (DD5JFK) & OpenWebRX+ (Marat Fayzullin)',
    detail: 'The OpenWebRX server and its OpenWebRX+ fork — protocol reference for the OpenWebRX backend (waterfall, audio, modes, decoders and chat).' },
  { name: 'KiwiSDR — John Seamons (ZL/KF6VO)',
    detail: 'The KiwiSDR receiver and its open web client — protocol reference for the KiwiSDR backend.' },
  { name: 'Opus — Xiph.Org Foundation',
    detail: 'Audio codec used for all streaming and decoding.' },
  { name: 'EiBi',
    detail: 'Shortwave broadcast schedules used for live station bookmarks.' },
  { name: 'GQRX, KiwiSDR, CuteSDR, SdrDx, OpenWebRX, matplotlib',
    detail: 'Origins of the waterfall colour palettes.' },
  { name: 'Leaflet, OpenStreetMap & CARTO',
    detail: 'Map rendering and tiles for the HFDL / digital / CW maps.' },
  { name: 'Atkinson Hyperlegible — Braille Institute',
    detail: 'Primary UI typeface. Nixie One and VT323 are used for the frequency displays.' },
  { name: 'React Native, Expo, Hermes, Skia, Reanimated, Gesture Handler, OkHttp',
    detail: 'The frameworks and libraries that make the app run.' },
];

export default function AboutOverlay({ visible, onClose }: AboutOverlayProps) {
  if (!visible) return null;
  return (
    <Modal
      visible
      animationType="slide"
      supportedOrientations={['portrait', 'landscape']}
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.bar}>
          <TouchableOpacity onPress={onClose} hitSlop={12} activeOpacity={0.7}>
            <Text style={styles.back}>← SDR</Text>
          </TouchableOpacity>
          <Text style={styles.title}>About VibeSDR</Text>
          <View style={{ width: 50 }} />
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <View style={styles.heroRow}>
            <Image source={require('../../assets/icon.png')} style={styles.icon} />
            <View style={{ flex: 1 }}>
              <Text style={styles.appName}>VibeSDR V4</Text>
              <Text style={styles.appVer}>Version {APP_VERSION}</Text>
              <Text style={styles.appSub}>A native mobile client for UberSDR, OpenWebRX & KiwiSDR receivers — and your own RTL-SDR hardware</Text>
            </View>
          </View>

          <Text style={styles.section}>A MESSAGE FROM STUART</Text>
          {STUART_MESSAGE.map((p, i) => (
            <Text key={i} style={[styles.body, { marginBottom: 10 }]}>{p}</Text>
          ))}
          <TouchableOpacity onPress={() => Linking.openURL(STUEY_URL)}>
            <Text style={styles.link}>Visit my UberSDR instance: stuey3d.tunnel.ubersdr.org</Text>
          </TouchableOpacity>

          <Text style={styles.section}>WHAT'S NEW IN V5</Text>
          {V5_CHANGES.map((c) => (
            <View key={c} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>{c}</Text>
            </View>
          ))}

          <Text style={styles.section}>V4 HIGHLIGHTS</Text>
          {V4_CHANGES.map((c) => (
            <View key={c} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>{c}</Text>
            </View>
          ))}

          <Text style={styles.section}>V3 HIGHLIGHTS</Text>
          {V3_CHANGES.map((c) => (
            <View key={c} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>{c}</Text>
            </View>
          ))}

          <Text style={styles.section}>V2 HIGHLIGHTS</Text>
          {V2_CHANGES.map((c) => (
            <View key={c} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>{c}</Text>
            </View>
          ))}

          <Text style={styles.section}>VERSION HISTORY</Text>
          {VERSION_HISTORY.map((v) => (
            <View key={v.v} style={styles.creditBlock}>
              <Text style={styles.creditName}>{v.v}</Text>
              <Text style={styles.creditDetail}>{v.detail}</Text>
            </View>
          ))}

          <Text style={styles.section}>FUTURE PLANS</Text>
          {FUTURE_PLANS.map((p, i) => (
            <Text key={i} style={styles.body}>{p}</Text>
          ))}

          <Text style={styles.section}>CREDITS</Text>
          <Text style={styles.body}>
            VibeSDR stands on the work of other open projects. Thank you to all of them.
          </Text>
          {CREDITS.map((c) => (
            <View key={c.name} style={styles.creditBlock}>
              <Text style={styles.creditName}>{c.name}</Text>
              <Text style={styles.creditDetail}>{c.detail}</Text>
            </View>
          ))}

          <Text style={styles.section}>LICENCE</Text>
          <Text style={styles.body}>
            VibeSDR is free software, released under the GNU General Public License
            version 3 (GPL-3.0). Here “free” means freedom, not price: you’re free to
            use, study, share and modify it, and the complete source code is public.
          </Text>
          <Text style={styles.body}>
            If you bought VibeSDR from an app store, that nominal price simply covers the
            store’s distribution and developer-account fees — the GPL expressly allows
            charging for distribution, and paying changes none of your freedoms. You can
            always get the source and build it yourself for nothing. Distributed in the
            hope that it’s useful, but WITHOUT ANY WARRANTY — without even the implied
            warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
          </Text>
          <TouchableOpacity onPress={() => Linking.openURL('https://github.com/Stuey3D/VibeSDR')}>
            <Text style={styles.link}>Source code: github.com/Stuey3D/VibeSDR</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => Linking.openURL('https://www.gnu.org/licenses/gpl-3.0.html')}>
            <Text style={styles.link}>www.gnu.org/licenses/gpl-3.0</Text>
          </TouchableOpacity>

          <Text style={styles.section}>PRIVACY</Text>
          <Text style={styles.body}>
            VibeSDR collects no personal data — no analytics, ads, or tracking.
            Location is optional and used only to sort instances by distance; deny it
            and everything still works. Your bookmarks and settings stay on your device.
          </Text>
          <TouchableOpacity onPress={() => Linking.openURL('https://github.com/Stuey3D/VibeSDR/blob/main/PRIVACY.md')}>
            <Text style={styles.link}>Full privacy policy</Text>
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const F = 'Atkinson Hyperlegible';

const styles = StyleSheet.create({
  root:  { flex: 1, backgroundColor: '#000' },
  bar:   {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingTop: 6, paddingBottom: 8, backgroundColor: '#0a0a0a',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.18)',
  },
  back:  { color: '#ffe566', fontFamily: F, fontSize: 16 },
  title: { color: 'rgba(255,255,255,0.85)', fontFamily: F, fontSize: 15 },

  scroll:  { flex: 1 },
  content: { paddingHorizontal: 18, paddingTop: 16 },

  heroRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 6 },
  icon:    { width: 64, height: 64, borderRadius: 14 },
  appName: { color: '#fff', fontFamily: F, fontSize: 22, fontWeight: 'bold', letterSpacing: 1 },
  appVer:  { color: '#ffe566', fontFamily: F, fontSize: 13, marginTop: 2 },
  appSub:  { color: 'rgba(255,255,255,0.70)', fontFamily: F, fontSize: 12, marginTop: 2 },

  section: {
    color: 'rgba(180,190,210,0.80)', fontFamily: F, fontSize: 12, fontWeight: 'bold',
    letterSpacing: 2, marginTop: 22, marginBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.12)',
    paddingTop: 14,
  },
  body: { color: 'rgba(255,255,255,0.85)', fontFamily: F, fontSize: 13, lineHeight: 19, marginBottom: 8 },

  bulletRow:  { flexDirection: 'row', gap: 8, marginBottom: 5, paddingRight: 4 },
  bulletDot:  { color: '#ffe566', fontFamily: F, fontSize: 13, lineHeight: 19 },
  bulletText: { flex: 1, color: 'rgba(255,255,255,0.85)', fontFamily: F, fontSize: 13, lineHeight: 19 },

  creditBlock:  { marginBottom: 12 },
  creditName:   { color: '#fff', fontFamily: F, fontSize: 13, fontWeight: 'bold' },
  creditDetail: { color: 'rgba(255,255,255,0.70)', fontFamily: F, fontSize: 12, lineHeight: 17, marginTop: 2 },

  link: { color: '#6ec8ff', fontFamily: F, fontSize: 13, marginTop: 2 },
});
