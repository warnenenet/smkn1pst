import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Volume2, Radio, Zap, VolumeX } from 'lucide-react';
import { buildKioskSpeechSentence, shouldTriggerPeakChime } from '../lib/attendanceEngine';
import type { Camera, Gate, TTSMode } from '../types';

interface CallPageViewProps {
  cameraId: number;
  isAuthenticated?: boolean;
  onBack: () => void;
  onTriggerDemoEvent?: (studentId?: number) => Promise<void>;
}

interface LaneEvent {
  uid: string;
  type: 'recognized' | 'anonymous';
  nama: string;
  kelas: string;
  nisn: string;
  status: string;
  tipe: string;
  timestamp: string;
  receivedAtMs: number;
}

interface KioskInfo {
  school_name: string;
  camera: Camera | null;
  gate: Gate | null;
  tts_mode: TTSMode;
  tts_max_age_sec: number;
  tts_burst_threshold: number;
  demo_student_id: number | null;
}

export const CallPageView: React.FC<CallPageViewProps> = ({
  cameraId,
  isAuthenticated = false,
  onBack,
  onTriggerDemoEvent,
}) => {
  const [kioskInfo, setKioskInfo] = useState<KioskInfo>({
    school_name: 'SMK Negeri Unggulan',
    camera: null,
    gate: null,
    tts_mode: 'AUTO_ADAPTIVE',
    tts_max_age_sec: 3,
    tts_burst_threshold: 3,
    demo_student_id: 1,
  });
  const [wsConnected, setWsConnected] = useState(false);
  const [clock, setClock] = useState(new Date().toLocaleTimeString('id-ID'));
  const [lanes, setLanes] = useState<LaneEvent[]>([]);
  const [ttsMuted, setTtsMuted] = useState(false);
  const [ttsModeOverride, setTtsModeOverride] = useState<TTSMode | null>(null);
  const [peakActive, setPeakActive] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [audioEngineLabel, setAudioEngineLabel] = useState<'Auto' | 'Piper Offline' | 'Web Speech'>('Auto');
  const [activeSpokenText, setActiveSpokenText] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextChimeTimeRef = useRef<number>(0);
  const ttsCooldownRef = useRef<Map<string, number>>(new Map());
  const recentTimestampsRef = useRef<number[]>([]);
  const audioQueueRef = useRef<Array<{ name: string; createdAt: number }>>([]);
  const isSpeakingRef = useRef(false);
  const isPeakRef = useRef(false);

  const effectiveMode: TTSMode = ttsModeOverride ?? kioskInfo.tts_mode;
  const effectiveModeRef = useRef<TTSMode>(effectiveMode);
  effectiveModeRef.current = effectiveMode;
  const ttsMutedRef = useRef(ttsMuted);
  ttsMutedRef.current = ttsMuted;
  const kioskInfoRef = useRef(kioskInfo);
  kioskInfoRef.current = kioskInfo;

  const ensureAudioContext = useCallback(async (): Promise<AudioContext | null> => {
    if (typeof window === 'undefined') return null;
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AudioCtx();
      }
      if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume().catch(() => {});
      }
      if (audioCtxRef.current.state === 'suspended') {
        setAudioBlocked(true);
        return null;
      }
      setAudioBlocked(false);
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  const unlockAudio = useCallback(async () => {
    const ctx = await ensureAudioContext();
    if (ctx) {
      setAudioBlocked(false);
    }
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.getVoices();
      } catch {
        // ignore
      }
    }
  }, [ensureAudioContext]);

  // Auto-unlock audio pada interaksi pertama di halaman Kiosk
  useEffect(() => {
    const handler = () => {
      void unlockAudio();
    };
    window.addEventListener('pointerdown', handler, { passive: true });
    window.addEventListener('keydown', handler, { passive: true });
    if ('speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
    }
    return () => {
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('keydown', handler);
    };
  }, [unlockAudio]);

  const playGateChime = useCallback(
    async (kind: 'recognized' | 'anonymous') => {
      const ctx = await ensureAudioContext();
      if (!ctx) return;
      try {
        const now = ctx.currentTime;
        // Jadwalkan nada secara berurutan (gap 130ms) jika beberapa siswa terdeteksi bersamaan
        const startAt = Math.max(now + 0.01, nextChimeTimeRef.current);
        nextChimeTimeRef.current = startAt + 0.14;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (kind === 'recognized') {
          osc.type = 'sine';
          osc.frequency.setValueAtTime(784, startAt); // G5
          osc.frequency.setValueAtTime(1046.5, startAt + 0.055); // C6
          gain.gain.setValueAtTime(0.001, startAt);
          gain.gain.linearRampToValueAtTime(0.18, startAt + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.14);
          osc.start(startAt);
          osc.stop(startAt + 0.15);
        } else {
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(440, startAt);
          gain.gain.setValueAtTime(0.001, startAt);
          gain.gain.linearRampToValueAtTime(0.12, startAt + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.15);
          osc.start(startAt);
          osc.stop(startAt + 0.16);
        }
      } catch {
        // ignore audio scheduling failure
      }
    },
    [ensureAudioContext]
  );

  useEffect(() => {
    fetch(`/api/kiosk/${cameraId}`)
      .then((r) => r.json())
      .then((data: KioskInfo) => setKioskInfo(data))
      .catch(() => {});
  }, [cameraId]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setClock(new Date().toLocaleTimeString('id-ID'));
      const cutoff = Date.now() - 12_000;
      setLanes((prev) => prev.filter((l) => l.receivedAtMs >= cutoff));
      recentTimestampsRef.current = recentTimestampsRef.current.filter((ts) => ts >= Date.now() - 5000);
      const isPeakNow = recentTimestampsRef.current.length >= kioskInfoRef.current.tts_burst_threshold;
      isPeakRef.current = isPeakNow;
      setPeakActive(isPeakNow);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const speakWithWebSpeech = useCallback(async (sentence: string, isPeak: boolean) => {
    if (!('speechSynthesis' in window)) return;
    const synth = window.speechSynthesis;

    // Hindari bug Chromium yang menggugurkan ucapan baru jika cancel() dipanggil sinkron saat idle
    if (synth.speaking || synth.pending) {
      synth.cancel();
      await new Promise((r) => window.setTimeout(r, 60));
    }

    await new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (!finished) {
          finished = true;
          resolve();
        }
      };

      const utter = new SpeechSynthesisUtterance(sentence);
      const voices = synth.getVoices();
      const idVoice = voices.find((v) => v.lang.toLowerCase().startsWith('id'));
      if (idVoice) {
        utter.voice = idVoice;
        utter.lang = idVoice.lang;
      } else {
        utter.lang = 'id-ID';
      }
      utter.rate = isPeak ? 1.28 : 1.08;
      utter.pitch = 1.0;
      utter.onend = done;
      utter.onerror = done;

      setAudioEngineLabel('Web Speech');
      synth.speak(utter);
      window.setTimeout(done, isPeak ? 2600 : 2200);
    });
  }, []);

  const drainAudioQueue = useCallback(async () => {
    if (isSpeakingRef.current || ttsMutedRef.current) return;
    isSpeakingRef.current = true;
    try {
      while (audioQueueRef.current.length > 0 && !ttsMutedRef.current) {
        const mode = effectiveModeRef.current;
        if (mode === 'CHIME_ONLY') {
          audioQueueRef.current = [];
          break;
        }

        const nowMs = Date.now();
        const maxAgeMs = Math.max(2000, kioskInfoRef.current.tts_max_age_sec * 1000);
        // Buang panggilan yang sudah terlewat terlalu lama agar audio tetap selaras dengan siswa di gerbang
        const freshItems = audioQueueRef.current.filter((it) => nowMs - it.createdAt <= maxAgeMs);
        audioQueueRef.current = [];
        if (freshItems.length === 0) break;

        const isBatchPeak =
          mode === 'AUTO_ADAPTIVE' && (isPeakRef.current || freshItems.length >= 2);
        const batchNames = isBatchPeak ? freshItems.slice(-4).map((it) => it.name) : [freshItems[0].name];

        // Jika masih ada sisa item non-peak, kembalikan ke antrean
        if (!isBatchPeak && freshItems.length > 1) {
          audioQueueRef.current = freshItems.slice(1);
        }

        const sentence = buildKioskSpeechSentence({
          names: batchNames,
          mode,
          isPeak: isBatchPeak,
        });
        if (!sentence) continue;

        setActiveSpokenText(sentence);
        let playedPiper = false;
        try {
          const resp = await fetch(`/api/tts?text=${encodeURIComponent(sentence)}`);
          if (resp.status === 200) {
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            playedPiper = await new Promise<boolean>((resolve) => {
              const audio = new Audio(url);
              audio.playbackRate = isBatchPeak ? 1.25 : 1.0;
              audio.onended = () => {
                URL.revokeObjectURL(url);
                resolve(true);
              };
              audio.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(false);
              };
              audio
                .play()
                .then(() => {
                  setAudioEngineLabel('Piper Offline');
                  setAudioBlocked(false);
                })
                .catch((err) => {
                  URL.revokeObjectURL(url);
                  if (err?.name === 'NotAllowedError') {
                    setAudioBlocked(true);
                  }
                  resolve(false);
                });
            });
          }
        } catch {
          // fallback ke Web Speech
        }

        if (!playedPiper) {
          await speakWithWebSpeech(sentence, isBatchPeak);
        }
      }
    } finally {
      setActiveSpokenText(null);
      isSpeakingRef.current = false;
    }
  }, [speakWithWebSpeech]);

  const enqueueAudioFeedback = useCallback(
    (nickname: string, kind: 'recognized' | 'anonymous', bypassCooldown = false) => {
      if (ttsMutedRef.current) return;
      const now = Date.now();
      recentTimestampsRef.current = [...recentTimestampsRef.current.filter((t) => now - t <= 5000), now];
      const recent5s = recentTimestampsRef.current.length;

      // Bunyi chime instan berurutan (<20ms) menandakan kamera berhasil scan tanpa perlu berhenti
      void playGateChime(kind);
      if (kind !== 'recognized') return;

      const mode = effectiveModeRef.current;
      const isPeakNow = shouldTriggerPeakChime({
        mode,
        recentEvents5s: recent5s,
        burstThreshold: kioskInfoRef.current.tts_burst_threshold,
      });
      isPeakRef.current = isPeakNow;
      setPeakActive(isPeakNow);

      // Hanya mode CHIME_ONLY yang menonaktifkan suara nama sepenuhnya
      if (mode === 'CHIME_ONLY') {
        audioQueueRef.current = [];
        return;
      }

      if (!bypassCooldown) {
        const lastSpoken = ttsCooldownRef.current.get(nickname) ?? 0;
        if (now - lastSpoken < 20_000) return;
      }
      ttsCooldownRef.current.set(nickname, now);

      // Batasi antrean maks 6 item terbaru agar saat jam sibuk dapat digabung menjadi batch 1 kalimat cepat
      if (audioQueueRef.current.length >= 6) {
        audioQueueRef.current.shift();
      }
      audioQueueRef.current.push({ name: nickname, createdAt: now });
      void drainAudioQueue();
    },
    [drainAudioQueue, playGateChime]
  );

  const enqueueFeedbackRef = useRef(enqueueAudioFeedback);
  enqueueFeedbackRef.current = enqueueAudioFeedback;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: number | null = null;
    let unmounted = false;

    const connect = () => {
      if (unmounted) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws?camera_id=${cameraId}`);

      ws.onopen = () => setWsConnected(true);
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          // Strict per-camera isolation
          if (data.camera_id && Number(data.camera_id) !== cameraId) return;

          if (data.event === 'student_recognized') {
            const evItem: LaneEvent = {
              uid: `${data.student_id}-${Date.now()}-${Math.random()}`,
              type: 'recognized',
              nama: data.nama,
              kelas: data.kelas,
              nisn: data.nisn,
              status: data.status || 'HADIR',
              tipe: data.tipe || 'MASUK',
              timestamp: data.timestamp,
              receivedAtMs: Date.now(),
            };
            setLanes((prev) => [evItem, ...prev].slice(0, 8));
            enqueueFeedbackRef.current(data.nickname || data.nama, 'recognized', false);
          } else if (data.event === 'face_detected' && data.anonymous) {
            const evItem: LaneEvent = {
              uid: `anon-${Date.now()}-${Math.random()}`,
              type: 'anonymous',
              nama: 'Wajah Baru (Menunggu Verifikasi BK)',
              kelas: 'Tamu / Belum Enroll',
              nisn: '-',
              status: 'ANONIM',
              tipe: 'DETEKSI',
              timestamp: data.timestamp,
              receivedAtMs: Date.now(),
            };
            setLanes((prev) => [evItem, ...prev].slice(0, 8));
            enqueueFeedbackRef.current('Wajah baru', 'anonymous', false);
          }
        } catch {
          // ignore invalid frame
        }
      };
      ws.onclose = () => {
        setWsConnected(false);
        if (!unmounted) {
          reconnectTimeout = window.setTimeout(connect, 3000);
        }
      };
    };

    connect();
    return () => {
      unmounted = true;
      if (reconnectTimeout) window.clearTimeout(reconnectTimeout);
      ws?.close();
    };
  }, [cameraId]);

  const handleLocalBurstTest = async () => {
    await unlockAudio();
    const sample = [
      { id: 101, nama: 'Raka Pratama', nick: 'Raka', kelas: 'XI RPL 1', nisn: '0081122001', status: 'HADIR' },
      { id: 102, nama: 'Siti Nurhayati', nick: 'Siti', kelas: 'X TKJ 1', nisn: '0081122002', status: 'HADIR' },
      { id: 103, nama: 'Dimas Aditya Putra', nick: 'Dimas', kelas: 'XI RPL 1', nisn: '0081122003', status: 'TERLAMBAT' },
      { id: 104, nama: 'Fajar Ramadhan', nick: 'Fajar', kelas: 'X TKJ 1', nisn: '0081122005', status: 'HADIR' },
    ];
    const nowTime = new Date().toTimeString().slice(0, 8);
    const items: LaneEvent[] = sample.map((s, idx) => ({
      uid: `burst-${s.id}-${Date.now()}-${idx}`,
      type: 'recognized',
      nama: s.nama,
      kelas: s.kelas,
      nisn: s.nisn,
      status: s.status,
      tipe: 'MASUK',
      timestamp: nowTime,
      receivedAtMs: Date.now(),
    }));
    setLanes((prev) => [...items, ...prev].slice(0, 8));
    for (const s of sample) {
      enqueueAudioFeedback(s.nick, 'recognized', true);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between p-6">
      {/* Top Isolated Camera Kiosk Header */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> {isAuthenticated ? 'Kembali ke Dashboard' : 'Portal Orang Tua'}
          </button>
          <div>
            <div className="text-sm font-bold text-white">
              {kioskInfo.camera?.nama_kamera ?? `Kamera #${cameraId}`} ·{' '}
              <span className="text-blue-400">{kioskInfo.gate?.nama_gerbang ?? 'Gerbang Utama'}</span>
            </div>
            <div className="text-[11px] text-slate-400">
              {kioskInfo.school_name} · Speaker &amp; Monitor Khusus Lajur Kamera #{cameraId} (Siswa langsung jalan tanpa berhenti)
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <select
            aria-label="Mode Suara Kiosk"
            value={effectiveMode}
            onChange={(e) => {
              void unlockAudio();
              setTtsModeOverride(e.target.value as TTSMode);
            }}
            className="bg-slate-900 border border-slate-700 text-slate-200 rounded px-2.5 py-1 text-xs"
          >
            <option value="AUTO_ADAPTIVE">Audio: Auto Adaptif (Sepi=Kalimat, Sibuk=Chime + Batch Nama Cepat)</option>
            <option value="CHIME_ONLY">Audio: Chime Kilat Tanpa Ucapan (5000 Siswa)</option>
            <option value="FULL_NAME">Audio: Panggil Lengkap Semua</option>
          </select>

          <button
            type="button"
            onClick={() => {
              void unlockAudio();
              setTtsMuted((m) => !m);
            }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-slate-700 rounded text-slate-300 hover:text-white"
          >
            {ttsMuted ? <VolumeX className="w-3.5 h-3.5 text-red-400" /> : <Volume2 className="w-3.5 h-3.5" />}
            {ttsMuted ? 'Suara Nonaktif' : 'Suara Aktif'}
          </button>

          {peakActive && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-amber-500/20 text-amber-300 font-semibold">
              <Zap className="w-3.5 h-3.5" /> MODE JAM SIBUK (BATCH KILAT)
            </span>
          )}

          <span className={`inline-flex items-center gap-1.5 font-mono ${wsConnected ? 'text-emerald-400' : 'text-red-400'}`}>
            <Radio className="w-3.5 h-3.5" /> {wsConnected ? 'WS ISOLATED' : 'RECONNECTING'}
          </span>
          <span className="font-mono tabular-nums text-slate-300 text-sm font-semibold">{clock}</span>
        </div>
      </header>

      {audioBlocked && !ttsMuted && (
        <div className="mt-4 max-w-4xl w-full mx-auto">
          <button
            type="button"
            onClick={() => {
              void unlockAudio();
              void playGateChime('recognized');
            }}
            className="w-full py-2.5 px-4 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold text-center"
          >
            Speaker Gerbang Diblokir Browser (Autoplay Policy) — Klik Di Sini Untuk Mengaktifkan Suara &amp; TTS
          </button>
        </div>
      )}

      {/* Main Walk-Through Multi-Lane Display */}
      <main className="flex-1 flex flex-col justify-center py-6">
        {lanes.length === 0 ? (
          <div className="w-full max-w-3xl mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center space-y-3">
            <div className="text-2xl sm:text-3xl font-semibold text-slate-200">
              Silakan Jalan Terus Melalui Gerbang
            </div>
            <p className="text-sm text-slate-400">
              Kamera #{cameraId} memindai otomatis sambil berjalan. Saat jam sibuk, suara berbunyi bip cepat + memanggil nama rombongan tanpa membuat antrean.
            </p>
          </div>
        ) : (
          <div className="max-w-6xl w-full mx-auto space-y-4">
            {/* Highlight kartu terbaru */}
            <div
              className={`rounded-2xl border p-7 flex flex-wrap items-center justify-between gap-4 ${
                lanes[0].type === 'anonymous'
                  ? 'bg-amber-950/40 border-amber-500/50'
                  : lanes[0].status === 'TERLAMBAT'
                    ? 'bg-amber-950/30 border-amber-400/50'
                    : 'bg-emerald-950/40 border-emerald-500/60'
              }`}
            >
              <div>
                <div className="text-xs font-semibold tracking-wide uppercase text-emerald-400">
                  {lanes[0].type === 'anonymous'
                    ? 'WAJAH BARU TERDETEKSI'
                    : `${lanes[0].tipe} TERCATAT · ${lanes[0].status} · LANJUT JALAN`}
                </div>
                <div className="text-3xl sm:text-5xl font-bold text-white mt-1">{lanes[0].nama}</div>
                <div className="text-lg text-slate-300 mt-1">
                  {lanes[0].kelas} · <span className="font-mono">{lanes[0].nisn}</span>
                </div>
              </div>
              <div className="text-right font-mono tabular-nums">
                <div className="text-2xl font-bold text-white">{lanes[0].timestamp}</div>
                <div className="text-xs text-slate-400">
                  {activeSpokenText ? `TTS: "${activeSpokenText}"` : `Terbaru · Engine ${audioEngineLabel}`}
                </div>
              </div>
            </div>

            {/* Multi-lane parallel cards for simultaneous walk-through */}
            {lanes.length > 1 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {lanes.slice(1).map((item) => (
                  <div
                    key={item.uid}
                    className={`rounded-xl border p-4 ${
                      item.type === 'anonymous'
                        ? 'bg-slate-900 border-amber-500/40'
                        : 'bg-slate-900 border-emerald-500/40'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[11px] font-mono">
                      <span className={item.type === 'anonymous' ? 'text-amber-400' : 'text-emerald-400'}>
                        {item.status}
                      </span>
                      <span className="text-slate-400">{item.timestamp}</span>
                    </div>
                    <div className="text-base font-bold text-white truncate mt-1">{item.nama}</div>
                    <div className="text-xs text-slate-400 truncate">{item.kelas}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Footer / Demo Controls */}
      <footer className="border-t border-slate-800 pt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
        <span>
          URL Lajur Terisolasi: <code className="font-mono text-slate-200">/panggil/{cameraId}</code> · Engine Suara:{' '}
          <strong className="text-slate-200">{audioEngineLabel}</strong>
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void handleLocalBurstTest();
            }}
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded font-medium"
          >
            Simulasi Burst Jam Sibuk (4 Siswa)
          </button>
          {isAuthenticated && onTriggerDemoEvent && (
            <>
              <button
                type="button"
                onClick={() => {
                  void unlockAudio();
                  void onTriggerDemoEvent(kioskInfo.demo_student_id ?? 1);
                }}
                className="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 text-white rounded font-medium"
              >
                Simulasikan Siswa Terdeteksi
              </button>
              <button
                type="button"
                onClick={() => {
                  void unlockAudio();
                  void onTriggerDemoEvent(undefined);
                }}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded font-medium"
              >
                Simulasikan Wajah Anonim
              </button>
            </>
          )}
        </div>
      </footer>
    </div>
  );
};
