import { useEffect, useState } from 'react';
import type { AvatarOption, Page, Session } from '../lib/types';
import { PageHeader } from '../components/Layout';
import { fmtUsdt, PromoBalanceNote } from '../components/Balance';
import { api, ApiError } from '../lib/api';

interface Props {
  user: Session | null;
  onBack: () => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onNavigate: (page: Page) => void;
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
export function Profile({
  user,
  onBack,
  onDeposit,
  onWithdraw,
  onNavigate,
}: Props) {
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

  // ------------------------------------------------------------------
  // AVATAR
  //
  // La elección se guarda en el servidor y se copia al asiento. Los avatares
  // de miembro vienen con `unlocked` ya resuelto: si la membresía venció,
  // siguen visibles pero bloqueados, para que el jugador sepa qué se pierde.
  // ------------------------------------------------------------------
  const catalogo: AvatarOption[] = user?.avatarCatalog ?? [];
  const [avatar, setAvatar] = useState(user?.avatar ?? 'fox');
  const [guardandoAvatar, setGuardandoAvatar] = useState<string | null>(null);
  const [errorAvatar, setErrorAvatar] = useState('');

  useEffect(() => {
    if (user?.avatar) setAvatar(user.avatar);
  }, [user?.avatar]);

  const avatarActual =
    catalogo.find((a) => a.id === avatar) ??
    catalogo.find((a) => a.id === 'fox');

  const elegirAvatar = async (opcion: AvatarOption) => {
    if (!opcion.unlocked || guardandoAvatar) return;
    setGuardandoAvatar(opcion.id);
    setErrorAvatar('');
    try {
      await api.updateAvatar(opcion.id);
      setAvatar(opcion.id);
    } catch (err) {
      setErrorAvatar(
        err instanceof ApiError ? err.message : 'No se pudo cambiar el avatar.',
      );
    } finally {
      setGuardandoAvatar(null);
    }
  };

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      <PageHeader title="Mi perfil" onBack={onBack} />

      {/* ---------------- Identidad ---------------- */}
      <section className="flex items-center gap-4 mb-5">
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center text-3xl shrink-0 border-2 border-[#ffd700]/50"
          style={{
            background: 'linear-gradient(135deg, #2a2a4a 0%, #151525 100%)',
          }}
          aria-label={avatarActual?.label ?? 'Avatar'}
        >
          {avatarActual?.emoji ?? '🃏'}
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

      {/* ---------------- Avatar ---------------- */}
      {catalogo.length > 0 && (
        <section className="card mb-5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-white">Tu avatar de mesa</p>
            <span className="text-[10px] text-[#a0a0b0]">
              {catalogo.filter((a) => a.unlocked).length}/{catalogo.length}{' '}
              disponibles
            </span>
          </div>
          <p className="text-[10px] text-[#a0a0b0] leading-relaxed mb-3">
            Los avatares con corona son exclusivos del 3-Bet Club. Se mantienen
            aunque la membresía venza, pero no se pueden elegir de nuevo hasta
            renovar.
          </p>

          <div className="grid grid-cols-5 gap-2">
            {catalogo.map((opcion) => {
              const activo = opcion.id === avatar;
              const guardando = guardandoAvatar === opcion.id;
              return (
                <button
                  key={opcion.id}
                  onClick={() => elegirAvatar(opcion)}
                  disabled={!opcion.unlocked || !!guardandoAvatar}
                  title={
                    opcion.unlocked
                      ? opcion.label
                      : `${opcion.label} · exclusivo del 3-Bet Club`
                  }
                  className="relative rounded-xl h-12 flex items-center justify-center text-xl transition-transform active:scale-95 disabled:cursor-not-allowed"
                  style={{
                    background: activo ? 'rgba(0,210,106,0.14)' : '#151525',
                    border: `1px solid ${
                      activo ? '#00d26a' : opcion.memberOnly ? '#ffd70055' : '#2a2a4a'
                    }`,
                    opacity: opcion.unlocked ? 1 : 0.45,
                  }}
                >
                  {opcion.emoji}
                  {!opcion.unlocked && (
                    <span className="absolute -top-1 -right-1 text-[9px] leading-none bg-[#ffd700] text-black rounded-full px-1 py-0.5">
                      🔒
                    </span>
                  )}
                  {guardando && (
                    <span className="absolute inset-0 rounded-xl bg-black/60 flex items-center justify-center text-[9px] text-white">
                      …
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {errorAvatar && (
            <p className="text-[10px] text-[#ff8a94] mt-2">{errorAvatar}</p>
          )}
        </section>
      )}

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
      <div className="card flex items-start gap-3 mb-4">
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

      {/* La AGPL exige ofrecer el codigo fuente a quien usa el servicio por
          red. El enlace esta en el perfil y tambien en el pie de Inicio. */}
      <button
        onClick={() => onNavigate('source')}
        className="w-full text-center text-[10px] text-[#6c6c80] hover:text-[#a0a0b0] transition-colors py-2"
      >
        Código fuente · Licencia AGPL-3.0
      </button>
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
