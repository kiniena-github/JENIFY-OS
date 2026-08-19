import React, { useEffect, useState } from 'react';
import { useAuth } from '../auth.js';
import { api, ApiError } from '../api.js';

interface LoginInfo {
  name: string;
  logoPath: string | null;
  brandColor: string | null;
}

/**
 * Tenant-branded sign-in. Identity comes from the tenant's own branding
 * configuration (never hard-coded per factory); FactoryOS stays the product
 * line ("Powered by FactoryOS"). There is deliberately NO public sign-up —
 * staff accounts are created by factory admins only.
 */
export default function LoginPage() {
  const { login } = useAuth();
  const [info, setInfo] = useState<LoginInfo | null>(null);
  const [mode, setMode] = useState<'login' | 'recover'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<LoginInfo>('/api/login-info')
      .then((r) => {
        setInfo(r);
        if (r.brandColor) document.documentElement.style.setProperty('--primary', r.brandColor);
      })
      .catch(() => setInfo({ name: 'FactoryOS', logoPath: null, brandColor: null }));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username, password, remember);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  async function recover(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/recover', { username, code, newPassword });
      setNotice('Password changed — sign in with your new password.');
      setMode('login');
      setPassword('');
      setCode('');
      setNewPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Recovery failed');
    } finally {
      setBusy(false);
    }
  }

  const factoryName = info?.name ?? '…';

  return (
    <div className="login-page">
      <div className="login-brand">
        {info?.logoPath ? (
          <img
            src={info.logoPath}
            alt=""
            style={{ width: 84, height: 84, borderRadius: 14, objectFit: 'cover' }}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="logo-fallback">{factoryName.slice(0, 1)}</div>
        )}
        <h1>{factoryName}</h1>
        <p>
          One connected operational record — from receiving to final payment. Secure, role-based
          access.
        </p>
        <div className="loc">Authorized staff only. Activity is logged.</div>
      </div>
      <div className="login-form-side">
        {mode === 'login' ? (
          <>
            <h2>Welcome back</h2>
            <p className="sub">Sign in to continue.</p>
            {notice ? <div className="page-info">{notice}</div> : null}
            {error ? <div className="page-error">{error}</div> : null}
            <form onSubmit={submit}>
              <div className="field">
                <label>
                  Username or email <span className="req">*</span>
                </label>
                <input
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                />
              </div>
              <div className="field">
                <label>
                  Password <span className="req">*</span>
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <label className="flex" style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember this device
              </label>
              <button className="btn btn-primary" disabled={busy || !username || !password}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 10 }}
              onClick={() => {
                setMode('recover');
                setError('');
                setNotice('');
              }}
            >
              Forgot password?
            </button>
          </>
        ) : (
          <>
            <h2>Account recovery</h2>
            <p className="sub">
              Enter one of your emergency recovery codes. The code is consumed and your password
              changes immediately. If you have no codes, another Owner can reset your password.
            </p>
            {error ? <div className="page-error">{error}</div> : null}
            <form onSubmit={recover}>
              <div className="field">
                <label>
                  Username <span className="req">*</span>
                </label>
                <input value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
              <div className="field">
                <label>
                  Recovery code <span className="req">*</span>
                </label>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="XXXX-XXXX-XXXX"
                  autoComplete="one-time-code"
                />
              </div>
              <div className="field">
                <label>
                  New password <span className="req">*</span>
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <button
                className="btn btn-primary"
                disabled={busy || !username || !code || newPassword.length < 6}
              >
                {busy ? 'Working…' : 'Reset password'}
              </button>
            </form>
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 10 }}
              onClick={() => {
                setMode('login');
                setError('');
              }}
            >
              Back to sign in
            </button>
          </>
        )}
        <div className="login-note">Powered by FactoryOS — local factory deployment.</div>
      </div>
    </div>
  );
}
