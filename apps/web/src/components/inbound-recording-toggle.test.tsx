import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api-client';

import { InboundRecordingToggle } from './inbound-recording-toggle';

vi.mock('../lib/api-client', () => ({
  api: { voice: { recordingPreference: vi.fn(), setRecordingPreference: vi.fn() } },
}));

describe('inbound recording preference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.voice.recordingPreference).mockResolvedValue({
      numberId: 'pn1',
      recordCall: false,
    });
  });
  it('starts off and only opts in after the user toggles and the server confirms', async () => {
    vi.mocked(api.voice.setRecordingPreference).mockResolvedValue({
      numberId: 'pn1',
      recordCall: true,
    });
    render(<InboundRecordingToggle numberId="pn1" inCall={false} />);
    const toggle = screen.getByRole('switch', { name: 'Record call' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(api.voice.setRecordingPreference).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(api.voice.setRecordingPreference).toHaveBeenCalledWith('pn1', true);
  });
  it('retains the confirmed setting if saving fails', async () => {
    vi.mocked(api.voice.setRecordingPreference).mockRejectedValue(new Error('Could not save'));
    render(<InboundRecordingToggle numberId="pn1" inCall={false} />);
    const toggle = screen.getByRole('switch');
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
  it('cannot change the policy for a call already ringing or connected', async () => {
    render(<InboundRecordingToggle numberId="pn1" inCall />);
    await screen.findByText(/Incoming calls to this number are not recorded/);
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});
