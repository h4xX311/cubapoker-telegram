import type { Page, Session } from '../lib/types';
import { fmtUsdt, PromoBalanceNote } from '../components/Balance';

interface HomeProps {
  user: Session | null;
  onNavigate: (page: Page) => void;
  120?: number;
}

const NAV: { page: Page; emoji: string; label: string; sub: string; accent: string }[] = [
  {
    page: 'tables',
    emoji: '🃏',
    label: 'Campos cash',
    sub: '1 a 100 USDT',
    accent: 'from-[#00d26a] to-[#00b894]',
  },
  {
    page: 'freeroll',
    emoji: '🎁',
    label: 'Freeroll',
    sub: 'Gratis · sin buy-in',
    accent: 'from-[#ffd700] to-[#ffb700]',
  },
  {
    page: 'centroll',
    emoji: '⚡',
    label: 'Centroll',
    sub: '0,01 USDT',
    accent: 'from-[#e67e22] to-[#d35400]',
  },
  {
    page: 'tournaments',
    emoji: '🏆',
    label: 'Torneos',
    sub: 'Próximamente',
    accent: 'from-[#9b59b6] to-[#8e44ad]',
  },
  {
    page: 'vip',
    emoji: '👑',
    label: 'VIP',
    sub: 'Menos rake',
    accent: 'from-[#3498db] to-[#2980b9]',
  },
  {
    page: 'achievements',
    emoji: '🎖️',
    label: 'Logros',
    sub: 'Recompensas',
    accent: 'from-[#16a085] to-[#1abc9c]',
  },
  {
    page: 'referrals',
    emoji: '👥',
    label: 'Referidos',
    sub: 'Gana 10%',
    accent: 'from-[#7f8c8d] to-[#95a5a6]',
  },
];

export function Home({ user, onNavigate }: HomeProps) {
  const real = user?.balance?.real ?? 0;
  const play = user?.balance?.play ?? 0;
  const total = user?.balance?.total ?? 0;
  const stats = user?.stats;

  // Cuanto puede extraerse del saldo de promocion: el 10% de lo que tiene.
  // Es un techo teorico; en la practica es menos porque se pierde jugando.
  const maxExtractable = Math.floor(play * 10) / 100;

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <div className="mb-5">
        <p className="text-[#a0a0b0] text-sm">Hola</p>
        <h1 className="text-2xl font-bold text-white truncate">
          {user?.firstName || 'Jugador'}
        </h1>
      </div>

      {/* Saldo. La unidad de la cuenta es USDT; el CUP es referencia. */}
      <section
        className="rounded-2xl p-5 mb-2"
        style={{
          background: 'linear-gradient(135deg, #0d3b2e 0%, #0f3460 100%)',
          border: '1px solid rgba(0,210,106,0.25)',
        }}
        aria-label="Tu saldo"
      >
        <div className="flex items-start justify-between mb-3">
          <span className="text-[#a0a0b0] text-xs uppercase tracking-wide">
            Saldo total
          </span>
          {user?.vip && (
            <span className="badge badge-warning text-[10px]">{user.vip}</span>
          )}
        </div>

        <p className="text-4xl font-bold text-white leading-none">{fmtUsdt(total)}</p>
        <p className="text-sm text-[#a0a0b0] mt-1">
        </p>

        <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-white/10">
          <div>
            <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">
              Retirable
            </p>
            <p className="text-lg font-bold text-[#00d26a]">{fmtUsdt(real)}</p>
          </div>
          <div>
            <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">
              Promoción
            </p>
            <p className="text-lg font-bold text-[#ffd700]">{fmtUsdt(play)}</p>
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <button
            onClick={() => onNavigate('deposit')}
            className="flex-1 btn btn-primary py-2.5 text-sm"
          >
            Depositar
          </button>
          <button
            onClick={() => onNavigate('withdraw')}
            className="flex-1 btn btn-outline py-2.5 text-sm"
            disabled={real < 10}
            title={real < 10 ? 'Mínimo 10 USDT retirables' : undefined}
          >
            Retirar
          </button>
        </div>
      </section>

      {play > 0 && (
        <div className="mb-5">
          <PromoBalanceNote play={play} maxExtractable={maxExtractable} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 mb-6">
        {NAV.map((item, i) => (
          <button
            key={item.page}
            onClick={() => onNavigate(item.page)}
            className="card flex flex-col items-start p-4 text-left hover:border-[#00d26a] transition-all animate-slideUp"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <div
              className={`w-11 h-11 rounded-xl bg-gradient-to-br ${item.accent} flex items-center justify-center mb-3 shadow-lg`}
            >
              <span className="text-xl">{item.emoji}</span>
            </div>
            <span className="font-semibold text-white text-sm">{item.label}</span>
            <span className="text-[11px] text-[#a0a0b0]">{item.sub}</span>
          </button>
        ))}
      </div>

      <h2 className="text-[#a0a0b0] text-xs uppercase tracking-wide mb-3">
        Mi actividad
      </h2>
      <div className="grid grid-cols-3 gap-3 mb-6">
        <Stat label="Manos" value={stats?.handsPlayed ?? 0} color="#00d26a" />
        <Stat label="Ganadas" value={stats?.handsWon ?? 0} color="#ffd700" />
        <Stat label="Freerolls" value={stats?.freerollsPlayed ?? 0} color="#3498db" />
      </div>

      <div className="card flex items-start gap-3">
        <span className="text-lg">🔒</span>
        <div>
          <p className="text-sm font-semibold text-white mb-1">Juego responsable</p>
          <p className="text-xs text-[#a0a0b0] leading-relaxed">
            Los retiros se procesan en 24-72 h. Si deja de ser divertido, tómate un
            descanso. Solo para mayores de 18 años.
          </p>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="card text-center p-4">
      <p className="text-2xl font-bold" style={{ color }}>
        {value}
      </p>
      <p className="text-[10px] text-[#a0a0b0]">{label}</p>
    </div>
  );
}
