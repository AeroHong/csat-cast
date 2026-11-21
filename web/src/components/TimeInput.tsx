import { useEffect, useState } from 'react';
import { describeTime, parseTime24 } from '../core/time24';

/**
 * 24시간제 시각 입력 칸. 브라우저 기본 시간 칸(오전/오후 12시간제) 대신 글자로 받아 칸을 벗어날 때(또는 Enter) 정리한다.
 * 옆에 "오후 12:00"처럼 함께 보여 주어 오전/오후를 헷갈리지 않게 한다.
 * @param value "HH:MM:SS" (seconds=false면 "HH:MM")
 */
export default function TimeInput({
  value,
  onChange,
  seconds = true,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  seconds?: boolean;
  disabled?: boolean;
}) {
  const show = (v: string) => (seconds ? v : v.slice(0, 5));
  const [text, setText] = useState(show(value));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(show(value));
    setBad(false);
  }, [value]);

  const commit = () => {
    const t = parseTime24(text);
    if (!t) {
      // 읽을 수 없으면 원래 값으로 되돌린다
      setBad(text.trim() !== '');
      setText(show(value));
      return;
    }
    setBad(false);
    const v = seconds ? t : t.slice(0, 5);
    setText(v);
    if (v !== value) onChange(v);
  };

  const full = seconds ? value : `${value}:00`;
  return (
    <span className="time-input">
      <input
        type="text"
        inputMode="numeric"
        className={`mono ${bad ? 'bad' : ''}`}
        value={text}
        disabled={disabled}
        placeholder={seconds ? '13:05:00' : '13:05'}
        title="24시간제로 입력 (예: 13:05, 1305, 13시 5분, 오후 1:05)"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(show(value));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span className="muted small time-hint">{bad ? '형식 오류' : describeTime(full)}</span>
    </span>
  );
}
