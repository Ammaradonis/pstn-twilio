import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface SelectedNumberState {
  selectedNumberId: string | null;
  setSelectedNumberId: (id: string | null) => void;
}

export const useSelectedNumberStore = create<SelectedNumberState>()(
  persist(
    (set) => ({
      selectedNumberId: null,
      setSelectedNumberId: (selectedNumberId) => set({ selectedNumberId }),
    }),
    {
      name: 'pstn-twilio.selected-number',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
