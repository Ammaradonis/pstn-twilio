import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppLayout } from './components/app-layout';
import { RequireAuth } from './components/require-auth';
import { AnswerPage } from './pages/answer';
import { CallsPage } from './pages/calls';
import { Dashboard } from './pages/dashboard';
import { DialPage } from './pages/dial';
import { Login } from './pages/login';
import { MessagesPage } from './pages/messages';
import { NotFound } from './pages/not-found';
import { NumberDetail } from './pages/number-detail';
import { NumberNew } from './pages/number-new';
import { Numbers } from './pages/numbers';
import { Settings } from './pages/settings';
import { SettingsDiagnostics } from './pages/settings-diagnostics';
import { SettingsSecurity } from './pages/settings-security';
import { SettingsSheets } from './pages/settings-sheets';
import { SettingsTwilio } from './pages/settings-twilio';

// Only voice app accounts download the voice app.
const VoiceApp = lazy(() => import('./voice/voice-app').then((m) => ({ default: m.VoiceApp })));

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route element={<RequireAuth />}>
        <Route
          path="/voice/*"
          element={
            <Suspense fallback={<div className="min-h-screen bg-white" />}>
              <VoiceApp />
            </Suspense>
          }
        />
        <Route element={<AppLayout />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/numbers" element={<Numbers />} />
          <Route path="/numbers/new" element={<NumberNew />} />
          <Route path="/numbers/:numberId" element={<NumberDetail />} />
          <Route path="/numbers/:numberId/messages" element={<MessagesPage />} />
          <Route path="/numbers/:numberId/calls" element={<CallsPage />} />
          <Route path="/numbers/:numberId/answer" element={<AnswerPage />} />
          <Route path="/numbers/:numberId/dial" element={<DialPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/twilio" element={<SettingsTwilio />} />
          <Route path="/settings/security" element={<SettingsSecurity />} />
          <Route path="/settings/diagnostics" element={<SettingsDiagnostics />} />
          <Route path="/settings/sheets" element={<SettingsSheets />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
