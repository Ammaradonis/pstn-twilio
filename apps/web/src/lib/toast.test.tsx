import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToastProvider, useToast } from './toast';

function Harness({ onReady }: { onReady: (push: ReturnType<typeof useToast>['push']) => void }) {
  const { push } = useToast();
  onReady(push);
  return null;
}

describe('ToastProvider', () => {
  it('renders pushed toasts in the toaster', async () => {
    let push: ReturnType<typeof useToast>['push'] | null = null;
    render(
      <ToastProvider>
        <Harness onReady={(p) => (push = p)} />
      </ToastProvider>,
    );
    expect(push).not.toBeNull();
    act(() => {
      push!({ tone: 'success', title: 'Saved', message: 'Number was provisioned.' });
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Number was provisioned.')).toBeInTheDocument();
  });
});
