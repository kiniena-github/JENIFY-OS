import React, { useState } from 'react';
import { useAuth } from '../auth.js';
import { ApiError } from '../api.js';

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="login-page">
      <div className="login-brand">
        <div className="logo-fallback">F</div>
        <h1>FactoryOS</h1>
        <p>
          One connected operational record — from receiving to final payment. Secure, role-based
          access.
        </p>
        <div className="loc">Authorized staff only. Activity is logged.</div>
      </div>
      <div className="login-form-side">
        <h2>Welcome back</h2>
        <p className="sub">Sign in to continue.</p>
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
        <div className="login-note">FactoryOS — local factory deployment.</div>
      </div>
    </div>
  );
}
