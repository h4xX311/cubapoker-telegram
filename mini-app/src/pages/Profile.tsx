import type { Session } from '../lib/types';
import { PageHeader } from '../components/Layout';
import { fmtUsdt, PromoBalanceNote } from '../components/Balance';

interface Props {
  user: Session | null;
  onBack: () => void;
  onDeposit: () => void;
  onWithdraw: () => void;
}

/**
 * MI PERFIL
 * =========
 *
 * Reune lo que el jugador necesita saber de su cuenta sin abrir cinco pantallas: quien es,
 * cuanto tiene y como le ha ido.
 *
 * ------------------------------------------------------------------
 * POR QUE SE SEPARAN RETIRABLE Y PROMOCION AQUI TAMBIEN
 *
 * En el lobby ya se ven los dos saldos, pero el perfil es donde el jugador viene a
 * entenderlos. Poner solo el total seria comodo y enganoso: el total incluye el saldo de
 * promocion, que NO se puede retirar. Un jugador que ve "50 USDT" y pide un retiro de 50 se
 * lleva una sorpresa y una reclamacion.
 *
 * Aqui se dice, con las cifras delante, de donde sale cada parte y que hace falta para
 * convertir la promocion en dinero.
 * ------------------------------------------------------------------
 */
export function Profile({ user, onBack, onDeposit, onWithdraw }: Props) {
  const real = user?.balance?.real ?? 0;
  const play = user?.balance?.play ?? 0;
  const total = user?.balance?.total ?? 0;

  const stats = user?.stats;
  const manos = stats?.handsPlayed ?? 0;
  const ganadas = stats?.handsWon ?? 0;

  // Sin manos jugadas no hay porcentaje: mostrar "0%" sugiere que se pierde siempre, y
  // "—" es la verdad.
  const winRate = manos > 0 ? Math.round((ganadas / manos) * 100) : null;

  const nombre = [user?.firstName, user?.lastName].filter(Boolean).join(' ');

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Mi perfil" onBack={onBack} />

      {/* ---------------- Identidad ---------------- */}
      <section className="flex items-center gap-4 mb-5">
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold text-black shrink-0"
          style={{
            background: 'linear-gradient(135deg, #ffd700 0%, #e6a800 100%)',
          }}
        >
          {(user?.firstName || 'J').charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-white truncate">
            {nombre || 'Jugador'}
          </h2>
          <p className="text-sm text-[#a0a0b0] truncate">
            {user?.username ? `@${user.username}` : 'Sin usuario público'}
          </p>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="badge badge-warning">
              {user?.vip ? `VIP ${user.vip}` : 'Sin VIP'}
            </span>
            <span className="text-[10px] text-[#6c6c80]">
              ID {user?.telegramId ?? '—'}
            </span>
          </div>
        </div>
      </section>

      {/* ---------------- Saldo ---------------- */}
      <section
        className="rounded-2xl p-5 mb-3"
        style={{
          background: 'linear-gradient(135deg, #0d3b2e 0%, #0f3460 100%)',
          border: '1px solid rgba(0,210,106,0.25)',
        }}
      >
        <div className="flex items-baseline justify-between mb-3">
          <span className="text-[10px] uppercase tracking-wide text-[#a0a0b0]">
            Saldo total
          </span>
          <span className="text-2xl font-bold text-white">
            {fmtUsdt(total)}{' '}
            <span className="text-xs font-semibold text-[#a0a0b0]">USDT</span>
          </span>
        </div>

        <div className="space-y-2">
          <FilaSaldo
            etiqueta="Retirable"
            valor={real}
            color="#00d26a"
            nota="Depósitos y premios de cash. Se puede retirar."
          />
          <FilaSaldo
            etiqueta="Promoción"
            valor={play}
            color="#ffd700"
            nota="Premios de freeroll. Se juega; no se retira directamente."
          />
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onDeposit} className="flex-1 btn btn-primary py-2.5 text-sm">
            Depositar
          </button>
          <button
            onClick={onWithdraw}
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
          <PromoBalanceNote play={play} maxExtractable={Math.floor(play * 10) / 100} />
        </div>
      )}

      {/* ---------------- Estadisticas ---------------- */}
      <h2 className="text-[#a0a0b0] text-xs uppercase tracking-wide mb-3">
        Estadísticas
      </h2>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <Dato label="Manos jugadas" valor={manos} />
        <Dato label="Manos ganadas" valor={ganadas} color="#ffd700" />
        <Dato
          label="Tasa de victoria"
          valor={winRate === null ? '—' : `${winRate}%`}
          color="#00d26a"
        />
        <Dato label="Mesas jugadas" valor={stats?.tablesJoined ?? 0} />
        <Dato label="Freerolls" valor={stats?.freerollsPlayed ?? 0} color="#3498db" />
        <Dato
          label="Ganado en freerolls"
          valor={`${fmtUsdt(stats?.totalFreerollWon ?? 0)} USDT`}
          color="#ffd700"
          pequeno
        />
      </div>

      <div className="card flex items-center justify-between mb-5">
        <div>
          <p className="text-xs text-[#a0a0b0]">Rake pagado</p>
          <p className="text-sm font-semibold text-white mt-0.5">
            {fmtUsdt(stats?.totalRakePaid ?? 0)} USDT
          </p>
        </div>
        <span className="text-lg">🃏</span>
      </div>

      {/* ---------------- Juego responsable ---------------- */}
      <div className="card flex items-start gap-3">
        <span className="text-lg">🔒</span>
        <div>
          <p className="text-sm font-semibold text-white mb-1">Juego responsable</p>
          <p className="text-xs text-[#a0a0b0] leading-relaxed">
            Solo para mayores de 18 años. El póker es un juego de habilidad, pero
            también se puede perder: nunca apuestes dinero que necesites para
            vivir. Si deja de ser divertido, tómate un descanso.
          </p>
        </div>
      </div>
    </div>
  );
}

function FilaSaldo({
  etiqueta,
  valor,
  color,
  nota,
}: {
  etiqueta: string;
  valor: number;
  color: string;
  nota: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-white/5 last:border-0">
      <div className="min-w-0">
        <p className="text-xs font-semibold" style={{ color }}>
          {etiqueta}
        </p>
        <p className="text-[10px] text-[#6c6c80] leading-snug">{nota}</p>
      </div>
      <p className="text-sm font-bold text-white shrink-0">{fmtUsdt(valor)}</p>
    </div>
  );
}

function Dato({
  label,
  valor,
  color = '#ffffff',
  pequeno = false,
}: {
  label: string;
  valor: number | string;
  color?: string;
  pequeno?: boolean;
}) {
  return (
    <div className="card p-4">
      <p
        className={`font-bold ${pequeno ? 'text-base' : 'text-2xl'}`}
        style={{ color }}
      >
        {valor}
      </p>
      <p className="text-[10px] text-[#a0a0b0] mt-0.5">{label}</p>
    </div>
  );
}
