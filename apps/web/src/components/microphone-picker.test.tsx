import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { MicrophonePicker } from './microphone-picker';

it('offers real browser routes without inventing top/bottom microphone mappings', () => {
  const selectMicrophone = vi.fn();
  render(
    <MicrophonePicker
      voice={
        {
          microphoneInputs: [
            { deviceId: 'a', label: 'Speakerphone' },
            { deviceId: 'b', label: 'Headset earpiece' },
          ],
          selectedMicrophoneId: 'a',
          selectMicrophone,
          browserSupported: true,
          micPermission: 'granted',
        } as never
      }
    />,
  );
  expect(screen.getByRole('button', { name: 'Speakerphone' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Headset earpiece' }));
  expect(selectMicrophone).toHaveBeenCalledWith('b');
  expect(
    screen.getByText(/does not reliably expose separate top and bottom microphones/),
  ).toBeInTheDocument();
});
