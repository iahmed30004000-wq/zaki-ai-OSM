'use client';

import React, { useEffect, useRef, useState } from 'react';
import { RiMicLine, RiPauseLine, RiPlayLine } from '@remixicon/react';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { formatDuration } from './chat-model';

const SPEEDS = [1, 1.5, 2] as const;

/**
 * A VOICE NOTE, PLAYED IN PLACE — play/pause, a bar that can be dragged, the time, and the speed WhatsApp users expect (1× · 1.5×
 * · 2×). The sound comes from the inbox's authenticated media door; nothing is fetched until the first press (`preload=none`),
 * so a thread with twenty voice notes does not download twenty files on open.
 *
 * One note plays at a time: starting one pauses any other on the page.
 */
export function VoicePlayer({ src, voice, mine }: { src: string; voice: boolean; mine: boolean }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    const onTime = () => setCurrent(a.currentTime);
    const onMeta = () => setDuration(Number.isFinite(a.duration) ? a.duration : 0);
    const onEnd = () => {
      setPlaying(false);
      setCurrent(0);
    };
    const onPause = () => setPlaying(false);
    const onPlay = () => {
      setPlaying(true);
      document.querySelectorAll('audio').forEach((other) => {
        if (other !== a) other.pause();
      });
    };
    const onError = () => setFailed(true);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('durationchange', onMeta);
    a.addEventListener('ended', onEnd);
    a.addEventListener('pause', onPause);
    a.addEventListener('play', onPlay);
    a.addEventListener('error', onError);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('durationchange', onMeta);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('error', onError);
    };
  }, []);

  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) {
      setFailed(false);
      a.playbackRate = speed;
      void a.play().catch(() => setFailed(true));
    } else a.pause();
  };

  const nextSpeed = () => {
    const s = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(s);
    if (audio.current) audio.current.playbackRate = s;
  };

  const max = duration || 0;
  return (
    <div className="flex items-center gap-2 min-w-0 w-64 max-w-full" dir="ltr">
      <audio ref={audio} src={src} preload="none" className="hidden" />
      <span
        aria-hidden="true"
        className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${mine ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]' : 'bg-[var(--sys-surface-strong)] text-[var(--sys-muted-foreground)]'}`}
      >
        <RiMicLine className="w-4 h-4" />
      </span>
      <IconButton size="sm" label={playing ? 'إيقاف مؤقت' : voice ? 'تشغيل الرسالة الصوتية' : 'تشغيل الملف الصوتي'} onClick={toggle} className="shrink-0">
        {playing ? <RiPauseLine className="w-5 h-5" /> : <RiPlayLine className="w-5 h-5" />}
      </IconButton>
      <div className="flex-1 min-w-0">
        <input
          type="range"
          min={0}
          max={max || 1}
          step={0.1}
          value={Math.min(current, max || 1)}
          disabled={!max}
          aria-label="موضع التشغيل"
          onChange={(e) => {
            const v = Number(e.target.value);
            if (audio.current) audio.current.currentTime = v;
            setCurrent(v);
          }}
          className="w-full h-1.5 accent-[var(--sys-primary)] cursor-pointer disabled:cursor-default"
        />
        <div className="flex items-center justify-between text-note text-[var(--sys-muted-foreground)] tabular-nums">
          <span>{failed ? 'تعذّر التشغيل' : formatDuration(playing || current ? current : max)}</span>
          {max > 0 && <span>{formatDuration(max)}</span>}
        </div>
      </div>
      <Button variant="quiet" size="sm" onClick={nextSpeed} aria-label={`سرعة التشغيل ${speed}×`} className="shrink-0 tabular-nums">
        {speed}×
      </Button>
    </div>
  );
}
