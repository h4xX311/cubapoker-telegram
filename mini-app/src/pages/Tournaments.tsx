import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';
import { PageHeader, SectionLabel } from '../components/Layout';

interface Props {
  user: any;
  onBack: () => void;
  onBalanceChange?: () => void | Promise<any>;
}

const TYPE_META: Record<string, { icon: string; label: string }> = {
  sit_and_go: { icon: '⚡', label: 'Sit & Go' },
  scheduled: { icon: '📅', label: 'Programado' },
  freeroll: { icon: '🎁', label: 'Gratis' },
};

export function Tournaments({ user, onBack, onBalanceChange }: Props) {
  const [tournaments, setTournaments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const load = async () => {
    try {
      const res = await api.tournaments();
      setTournaments(res.tournaments || []);
    } catch {
      setTournaments([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const register = async (id: string) => {
    setBusyId(id);
    setNotice(null);
    try {
      await api.registerTournament(id);
      setNotice({ type: 'ok', text: 'Te registraste. Te avisaremos cuando empiece.' });
      await onBalanceChange?.();
      await load();
    } catch (err) {
      setNotice({
        type: 'err',
        text: err instanceof ApiError ? err.message : 'No se pudo completar el registro.',
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Torneos" onBack={onBack} />

      {loading ? (
        <div className="text-center py-12">
          <div className="spinner mx-auto mb-3" />
          <p className="text-sm text-[#a0a0b0]">Cargando torneos…</p>
        </div>
      ) : tournaments.length === 0 ? (
        <div className="card text-center py-10">
          <div className="text-4xl mb-3">🏆</div>
          <h2 className="font-semibold text-white mb-1">No hay torneos abiertos</h2>
          <p className="text-sm text-[#a0a0b0]">
            Vuelve pronto. Publicamos nuevos torneos cada día.
          </p>
        </div>
      ) : (
        <>
          {notice && (
            <div
              className={`rounded-xl p-3 mb-4 border text-sm ${
                notice.type === 'ok'
                  ? 'bg-[#00d26a]/10 border-[#00d26a] text-[#00d26a]'
                  : 'bg-[#ff4757]/10 border-[#ff4757] text-[#ff8a94]'
              }`}
            >
              {notice.text}
            </div>
          )}

          <div className="space-y-3">
            {tournaments.map((t, i) => {
              const meta = TYPE_META[t.type] ?? { icon: '🏆', label: 'Torneo' };
              const full = t.playerCount >= t.maxPlayers;
              const running = t.status === 'running';
              const isFree = t.buyIn === 0;
              const canAfford = isFree || (user?.balance?.credits ?? 0) >= t.buyIn;
              const progress = Math.min(100, (t.playerCount / t.maxPlayers) * 100);

              return (
                <article
                  key={t.id}
                  className="card animate-slideUp"
                  style={{ animationDelay: `${i * 50}ms` }}
                >
                  <header className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-2xl">{meta.icon}</span>
                      <div className="min-w-0">
                        <h3 className="font-semibold text-white truncate">{t.name}</h3>
                        <p className="text-xs text-[#a0a0b0]">{meta.label}</p>
                      </div>
                    </div>
                    <span
                      className={`badge text-[10px] ${
                        running ? 'badge-warning' : full ? 'badge-danger' : 'badge-success'
                      }`}
                    >
                      {running ? 'En curso' : full ? 'Llena' : 'Abierto'}
                    </span>
                  </header>

                  <div className="grid grid-cols-3 gap-2 mb-3 text-center">
                    <Stat label="Buy-in" value={isFree ? 'Gratis' : `${t.buyIn}`} unit={isFree ? '' : 'CUP'} />
                    <Stat label="Jugadores" value={`${t.playerCount}/${t.maxPlayers}`} />
                    <Stat label="Premio" value={`${t.prizePool ?? 0}`} unit="CUP" gold />
                  </div>

                  <div className="progress-bar mb-3">
                    <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
                  </div>

                  {!running && !full && (
                    <button
                      onClick={() => register(t.id)}
                      disabled={busyId === t.id || !canAfford}
                      className="w-full btn btn-primary py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {busyId === t.id
                        ? 'Registrando…'
                        : !canAfford
                        ? 'Saldo insuficiente'
                        : isFree
                        ? 'Participar gratis'
                        : `Inscribirse · ${t.buyIn} CUP`}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}

      <div className="mt-6 card">
        <SectionLabel>Cómo funciona</SectionLabel>
        <ul className="text-xs text-[#a0a0b0] space-y-1.5 leading-relaxed">
          <li>• <span className="text-white">Sit & Go</span>: empieza cuando se llena la mesa.</li>
          <li>• <span className="text-white">Programado</span>: fecha y hora fijas, premio garantizado.</li>
          <li>• <span className="text-white">Freeroll</span>: sin costo, solo para clasificar.</li>
          <li>• El reparto sigue la estructura estándar 50 / 30 / 20.</li>
        </ul>
      </div>
    </div>
  );
}

function Stat({ label, value, unit, gold }: { label: string; value: string; unit?: string; gold?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">{label}</p>
      <p className={`text-sm font-bold ${gold ? 'text-[#ffd700]' : 'text-white'}`}>
        {value}
        {unit && <span className="text-[10px] text-[#a0a0b0] ml-0.5">{unit}</span>}
      </p>
    </div>
  );
}
