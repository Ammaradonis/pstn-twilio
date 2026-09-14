import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CallQualityPanel } from './call-quality';

describe('CallQualityPanel', () => {
  it('shows placeholders before the first sample arrives', () => {
    render(<CallQualityPanel quality={null} warnings={[]} />);

    expect(screen.getByText('Latency').parentElement).toHaveTextContent('—');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('grades each metric against Twilio network guidance', () => {
    render(
      <CallQualityPanel
        quality={{ rttMs: 450, jitterMs: 20, packetLossPct: 0.4, mos: 4.3, codec: 'opus' }}
        warnings={[]}
      />,
    );

    expect(screen.getByText('450 ms').parentElement).toHaveClass('text-rose-800');
    expect(screen.getByText('20 ms').parentElement).toHaveClass('text-amber-800');
    expect(screen.getByText('0.4%').parentElement).toHaveClass('text-emerald-800');
    expect(screen.getByText('4.3').parentElement).toHaveClass('text-emerald-800');
    expect(screen.getByText('opus')).toBeInTheDocument();
  });

  it('explains active warnings once each and ignores unknown ones', () => {
    render(
      <CallQualityPanel
        quality={null}
        warnings={['high-rtt', 'constant-audio-input-level', 'something-new']}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('High latency');
    expect(alert).toHaveTextContent('No sound is coming from your microphone');
    expect(alert.querySelectorAll('li')).toHaveLength(2);
  });
});
