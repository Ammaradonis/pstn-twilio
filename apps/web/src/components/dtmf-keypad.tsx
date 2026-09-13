import { useCallback, useEffect, useRef, useState } from 'react';

const KEYS = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*', letters: '' },
  { digit: '0', letters: '+' },
  { digit: '#', letters: '' },
] as const;

const PRESS_FLASH_MS = 150;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

interface DtmfKeypadProps {
  onDigit: (digit: string) => void;
  disabled?: boolean;
}

// Touch-tone keypad for a live call, e.g. "press 5 to hear the code".
// The physical keyboard (0-9, *, #) presses the same keys.
export function DtmfKeypad({ onDigit, disabled = false }: DtmfKeypadProps) {
  const [sent, setSent] = useState('');
  const [pressed, setPressed] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const press = useCallback(
    (digit: string) => {
      if (disabled) return;
      onDigit(digit);
      setSent((prev) => `${prev}${digit}`.slice(-32));
      setPressed(digit);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setPressed(null), PRESS_FLASH_MS);
    },
    [disabled, onDigit],
  );

  useEffect(() => {
    if (disabled) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      if (isTypingTarget(event.target)) return;
      if (!/^[0-9*#]$/.test(event.key)) return;
      event.preventDefault();
      press(event.key);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [disabled, press]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  return (
    <div className="mt-4">
      <div
        className="flex min-h-[2.5rem] items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2"
        aria-live="polite"
      >
        <span className="truncate font-mono text-lg tracking-widest text-slate-900">
          {sent || <span className="text-sm tracking-normal text-slate-400">Keypad</span>}
        </span>
        {sent && (
          <button
            type="button"
            onClick={() => setSent('')}
            className="shrink-0 text-xs text-slate-500 hover:text-slate-700"
          >
            Clear
          </button>
        )}
      </div>
      <div
        role="group"
        aria-label="Call keypad"
        className="mx-auto mt-3 grid max-w-xs grid-cols-3 gap-2"
      >
        {KEYS.map(({ digit, letters }) => (
          <button
            key={digit}
            type="button"
            onClick={() => press(digit)}
            disabled={disabled}
            aria-label={`Send ${digit}`}
            className={`flex h-14 flex-col items-center justify-center rounded-lg border text-slate-900 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              pressed === digit
                ? 'border-emerald-400 bg-emerald-100'
                : 'border-slate-200 bg-white hover:bg-slate-50 active:bg-emerald-100'
            }`}
          >
            <span className="text-xl font-medium leading-none">{digit}</span>
            <span className="mt-0.5 h-3 text-[10px] leading-none tracking-wider text-slate-500">
              {letters}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-center text-xs text-slate-500">
        {disabled
          ? 'The keypad is available once the call is connected.'
          : 'Tap a key or type 0–9, *, # on your keyboard.'}
      </p>
    </div>
  );
}
