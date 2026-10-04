import type { Page, Session } from '../lib/types';

interface HomeProps {
  user: Session | null;
  onNavigate: (page: Page) => void;
}

const NAV: { page: Page; emoji: string; label: string; sub: string; accent: string }[] = [
  { page: 'tables', emoji: '🃏', label: 'Campos cash', sub: '7-max · 50 a 500', accent: 'from-[#00d26a] to-[#00b894]' },
  { page: 'freeroll', emoji: '🎁', label: 'Freeroll', sub: 'Gratis · 5-50 CUP', accent: 'from-[#ffd700] to-[#ffb700]' },
  { page: 'tournaments', emoji: '🏆', label: 'Torneos', sub: 'Con premio', accent: 'from-[#e67e22] to-[#d35400]' },
  { page: 'vip', emoji: '👑', label: 'VIP', sub: 'Menos rake', accent: 'from-[#9b59b6] to-[#8e44ad]' },
  { page: 'achievements', emoji: '🎖️', label: 'Logros', sub: 'Recompensas', accent: 'from-[#3498db] to-[#2980b9]' },
  { page: 'referrals', emoji: '👥', label: 'Referidos', sub: 'Gana 10%', accent: 'from-[#16a085] to-[#1abc9c]' },
];

export function Home({ user, onNavigate }: HomeProps) {
  const real = user?.balance?.real ?? 0;
  const play = user?.balance?.play ?? 0;
  const total = user?.balance?.total ?? 0;
  const stats = user?.stats;

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      {/* Saludo */}
      <div className="mb-5">
        <p className="text-[#a0a0b0] text-sm">Hola</p>
        <h1 className="text-2xl font-bold text-white truncate">
          {user?.firstName || 'Jugador'}
        </h1>
      </div>

      {/* Saldo: se separan real y promocion porque solo uno es retirable */}
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
          {user?.vip && <span className="badge badge-warning text-[10px]">{user.vip}</span>}
        </div>

        <p className="text-4xl font-bold text-white leading-none">
          {total}
          <span className="text-lg text-[#a0a0b0] font-normal ml-2">CUP</span>
        </p>

        {/* Desglose */}
        <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-white/10">
          <div>
            <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">
              Real · retirable
            </p>
            <p className="text-lg font-bold text-[#00d26a]">{real}</p>
          </div>
          <div>
            <p className="text-[10px] text-[#a0a0b0] uppercase tracking-wide">
              Promoción · solo jugar
            </p>
            <p className="text-lg font-bold text-[#ffd700]">{play}</p>
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
            disabled={real < 1000}
            title={real < 1000 ? 'Minimo 1000 CUP retirables' : undefined}
          >
            Retirar
          </button>
        </div>
      </section>

      {/* Aviso de saldo promo si existe */}
      {play > 0 && (
        <div
          className="rounded-xl p-3 mb-5 flex items-start gap-2.5"
          style={{ background: 'rgba(255,215,0,0.08)', border: '1px solid rgba(255,215,0,0.25)' }}
        >
          <span className="text-sm">⚠️</span>
          <p className="text-[11px] text-[#a0a0b0] leading-relaxed">
            Tienes <strong className="text-[#ffd700]">{play} CUP</strong> de promoción
            (freerolls y logros). Sirven para jugar en cualquier mesa cash pero{' '}
            <strong className="text-white">no se pueden retirar</strong>. Tu saldo
            retirable es {real} CUP.
          </p>
        </div>
      )}

      {/* Navegacion principal */}
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

      {/* Estadisticas */}
      <h2 className="text-[#a0a0b0] text-xs uppercase tracking-wide mb-3">
        Mi actividad
      </h2>
      <div className="grid grid-cols-3 gap-3 mb-6">
        <Stat label="Manos" value={stats?.handsPlayed ?? 0} color="#00d26a" />
        <Stat label="Ganadas" value={stats?.handsWon ?? 0} color="#ffd700" />
        <Stat label="Freerolls" value={stats?.freerollsPlayed ?? 0} color="#3498db" />
      </div>

      {/* Confianza */}
      <div className="card flex items-start gap-3">
        <span className="text-lg">🔒</span>
        <div>
          <p className="text-sm font-semibold text-white mb-1">Juego responsable</p>
          <p className="text-xs text-[#a0a0b0] leading-relaxed">
            Los retiros se procesan en 24-48 h. Si deja de ser divertido, tómate un
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
