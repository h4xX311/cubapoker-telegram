import type { Page, Session } from '../lib/types';

interface HomeProps {
  user: Session | null;
  onNavigate: (page: Page) => void;
}

const NAV_ITEMS: {
  page: Page;
  emoji: string;
  label: string;
  sub: string;
  accent: string;
}[] = [
  { page: 'game', emoji: '🎮', label: 'Jugar', sub: 'Cash game', accent: 'from-[#00d26a] to-[#00b894]' },
  { page: 'tournaments', emoji: '🏆', label: 'Torneos', sub: 'Premios reales', accent: 'from-[#ffd700] to-[#ffb700]' },
  { page: 'vip', emoji: '👑', label: 'VIP', sub: 'Menos rake', accent: 'from-[#e74c3c] to-[#c0392b]' },
  { page: 'achievements', emoji: '🎖️', label: 'Logros', sub: 'Recompensas', accent: 'from-[#9b59b6] to-[#8e44ad]' },
  { page: 'referrals', emoji: '👥', label: 'Referidos', sub: 'Gana 10%', accent: 'from-[#3498db] to-[#2980b9]' },
  { page: 'deposit', emoji: '💰', label: 'Depositar', sub: 'EnZona · USDT', accent: 'from-[#00d26a] to-[#00b894]' },
  { page: 'withdraw', emoji: '💸', label: 'Retirar', sub: '24-48 h', accent: 'from-[#ff4757] to-[#c0392b]' },
];

const PAYMENT_METHODS = [
  { flag: '🇨🇺', name: 'EnZona', note: 'Pago móvil' },
  { flag: '💳', name: 'QvaPay', note: 'Tarjeta' },
  { flag: '₮', name: 'USDT', note: 'TRC20' },
];

export function Home({ user, onNavigate }: HomeProps) {
  const usdEstimate = ((user?.balance?.credits ?? 0) / 350).toFixed(2);

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      {/* Saludo */}
      <div className="mb-5">
        <p className="text-[#a0a0b0] text-sm">Hola</p>
        <h1 className="text-2xl font-bold text-white truncate">
          {user?.firstName || 'Jugador'}
        </h1>
      </div>

      {/* Tarjeta de saldo */}
      <section
        className="rounded-2xl p-5 mb-5 relative overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, #0d3b2e 0%, #0f3460 100%)',
          border: '1px solid rgba(0,210,106,0.25)',
        }}
        aria-label="Tu saldo"
      >
        <div className="flex items-start justify-between mb-4">
          <span className="text-[#a0a0b0] text-xs uppercase tracking-wide">
            Saldo disponible
          </span>
          <span className="badge badge-success text-[10px]">Activo</span>
        </div>

        <p className="text-4xl font-bold text-white leading-none">
          {user?.balance?.credits ?? 0}
          <span className="text-lg text-[#a0a0b0] font-normal ml-2">CUP</span>
        </p>
        <p className="text-sm text-[#a0a0b0] mt-2">≈ {usdEstimate} USDT</p>

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
          >
            Retirar
          </button>
        </div>
      </section>

      {/* Acciones */}
      <h2 className="text-[#a0a0b0] text-xs uppercase tracking-wide mb-3">Jugar</h2>
      <div className="grid grid-cols-2 gap-3 mb-6">
        {NAV_ITEMS.filter(i => ['game', 'tournaments', 'vip', 'achievements'].includes(i.page)).map(
          (item, i) => (
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
              <span className="text-xs text-[#a0a0b0]">{item.sub}</span>
            </button>
          ),
        )}
      </div>

      {/* Dinero */}
      <h2 className="text-[#a0a0b0] text-xs uppercase tracking-wide mb-3">Mi dinero</h2>
      <div className="grid grid-cols-3 gap-3 mb-6">
        {NAV_ITEMS.filter(i => ['referrals', 'deposit', 'withdraw'].includes(i.page)).map(
          (item, i) => (
            <button
              key={item.page}
              onClick={() => onNavigate(item.page)}
              className="card flex flex-col items-center p-4 hover:border-[#00d26a] transition-all animate-slideUp"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <div
                className={`w-10 h-10 rounded-full bg-gradient-to-br ${item.accent} flex items-center justify-center mb-2`}
              >
                <span className="text-lg">{item.emoji}</span>
              </div>
              <span className="font-semibold text-white text-xs text-center leading-tight">
                {item.label}
              </span>
            </button>
          ),
        )}
      </div>

      {/* Métodos de pago */}
      <h2 className="text-[#a0a0b0] text-xs uppercase tracking-wide mb-3">
        Métodos de pago
      </h2>
      <div className="card mb-6">
        <div className="grid grid-cols-3 gap-3">
          {PAYMENT_METHODS.map(m => (
            <div key={m.name} className="flex flex-col items-center gap-1.5">
              <span className="text-xl">{m.flag}</span>
              <span className="text-xs font-semibold text-white">{m.name}</span>
              <span className="text-[10px] text-[#a0a0b0]">{m.note}</span>
            </div>
          ))}
        </div>
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
