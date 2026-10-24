import { useState, useEffect } from 'react';
import { api, ApiError } from '../lib/api';
import type {
  CashTier,
  FreerollCampo,
  FreerollSlot,
  Page,
  Session,
} from '../lib/types';
import { fmtUsdt, fmtStake, PromoBalanceNote } from '../components/Balance';
import { fmtCuenta, horaLocal, segundosHasta } from '../lib/tiempo';

interface HomeProps {
  user: Session | null;
  onNavigate: (page: Page) => void;
  onPlay: (tableId: string) => void;
}

type Pestana = 'cash' | 'freeroll' | 'torneos';

/**
 * EL LOBBY
 * ========
 *
 * Es la pantalla que decide si el jugador se queda. Tiene que responder, en este orden, a
 * tres preguntas:
 *
 *   1. ¿Cuanto dinero tengo?             -> tarjeta de saldo, arriba del todo.
 *   2. ¿Hay algo que pueda jugar AHORA?  -> accion directa (seguir jugando / freeroll en curso).
 *   3. ¿Que me ofreces?                   -> pestanas Cash / Freerolls / Torneos.
 *
 * ------------------------------------------------------------------
 * POR QUE PESTANAS Y NO UNA REJILLA DE TARJETAS
 *
 * La version anterior eran siete tarjetas iguales ("Campos cash", "Freeroll", "Centroll",
 * "Torneos", "VIP", "Logros", "Referidos"). Todas del mismo tamano y del mismo color, sin
 * decir en ninguna el buy-in, el premio ni cuanto se tarda. El jugador que entra por primera
 * vez tiene que abrir cuatro pantallas para saber que puede jugar con 1 USDT.
 *
 * Aqui el dinero y el juego estan separados de los extras (VIP, logros, referidos), que
 * pasan a accesos pequenos. Y cada tarjeta de juego dice lo que cuesta y lo que se puede
 * ganar, que es la informacion que se mira antes de sentarse.
 *
 * ------------------------------------------------------------------
 * LOS DATOS SE PIDEN AL ENTRAR, NO AL PULSAR
 *
 * Si el buy-in de un campo se cargara al abrir la pantalla de mesas, el jugador veria un
 * "—" en el lobby y despues un numero distinto. Se pide todo al entrar: config del producto,
 * freeroll del momento y si tiene una mesa abierta.
 */
export function Home({ user, onNavigate, onPlay }: HomeProps) {
  const real = user?.balance?.real ?? 0;
  const play = user?.balance?.play ?? 0;
  const total = user?.balance?.total ?? 0;
  const stats = user?.stats;

  const [pestana, setPestana] = useState<Pestana>('cash');
  const [tiers, setTiers] = useState<CashTier[]>([]);
  const [abierto, setAbierto] = useState<FreerollCampo | null>(null);
  const [enJuego, setEnJuego] = useState<FreerollCampo[]>([]);
  const [proximos, setProximos] = useState<FreerollSlot[]>([]);
  const [miMesa, setMiMesa] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState('');
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    // `allSettled`: si el freeroll falla, la pestana de cash tiene que seguir funcionando.
    Promise.allSettled([
      api.gameConfig().then((c) => setTiers(c?.cashTiers ?? [])),
      api.freerolls().then((f) => {
        setAbierto(f?.abierto ?? null);
        setEnJuego(f?.enJuego ?? []);
        setProximos(f?.proximos ?? []);
      }),
      api.myTable().then((r) => setMiMesa(r?.tableId ?? null)),
    ]);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const maxExtractable = Math.floor(play * 10) / 100;

  /**
   * Inscribirse desde el lobby, sin abrir otra pantalla.
   *
   * Se actualiza el estado local en vez de recargar: una peticion de mas en un boton que el
   * jugador acaba de pulsar solo sirve para que el numero parpadee. La lista se refresca
   * sola cada vez que se entra a la pantalla de freerolls.
   */
  const inscribirme = async (fieldId: string) => {
    setOcupado(true);
    setAviso('');
    try {
      await api.registerFreeroll(fieldId);

      if (abierto?.fieldId === fieldId) {
        setAbierto({ ...abierto, inscrito: true, inscritos: abierto.inscritos + 1 });
      }
      setEnJuego((prev) =>
        prev.map((c) =>
          c.fieldId === fieldId
            ? { ...c, inscrito: true, inscritos: c.inscritos + 1 }
            : c,
        ),
      );
    } catch (err) {
      setAviso(
        err instanceof ApiError ? err.message : 'No se pudo inscribir.',
      );
    } finally {
      setOcupado(false);
    }
  };

  const volverAMiMesa = async () => {
    if (miMesa) {
      onPlay(miMesa);
      return;
    }

    try {
      const r = await api.myTable();
      if (r?.tableId) onPlay(r.tableId);
      else setAviso('No tienes ninguna mesa abierta.');
    } catch {
      setAviso('No se pudo abrir tu mesa.');
    }
  };

  // El freeroll que exige accion AHORA: el que esta en juego con registro tardio. Si no hay
  // ninguno, el proximo que se puede jugar.
  const urgente: FreerollCampo | null = enJuego[0] ?? abierto;
  const enCurso = enJuego.length > 0;

  return (
    <div className="p-4 pb-10 animate-fadeIn">
      {/* ---------------- Cabecera ---------------- */}
      <header className="flex items-center justify-between mb-5">
        <div className="min-w-0">
          <p className="text-[#a0a0b0] text-xs">Bienvenido</p>
          <h1 className="text-xl font-bold text-white truncate">
            {user?.firstName || 'Jugador'}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onNavigate('profile')}
            className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-black transition-transform active:scale-95"
            style={{
              background: 'linear-gradient(135deg, #ffd700 0%, #e6a800 100%)',
            }}
            aria-label="Mi perfil"
          >
            {(user?.firstName || 'J').charAt(0).toUpperCase()}
          </button>
        </div>
      </header>

      {/* ---------------- Saldo ---------------- */}
      <section
        className="rounded-2xl p-5 mb-2"
        style={{
          background: 'linear-gradient(135deg, #0d3b2e 0%, #0f3460 100%)',
          border: '1px solid rgba(0,210,106,0.25)',
        }}
        aria-label="Tu saldo"
      >
        <span className="text-[#a0a0b0] text-xs uppercase tracking-wide">
          Saldo total
        </span>
        <p className="text-4xl font-bold text-white leading-none mt-2">
          {fmtUsdt(total)}{' '}
          <span className="text-base font-semibold text-[#a0a0b0]">USDT</span>
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

      {/* ---------------- Accion inmediata ----------------
          Solo aparece si de verdad hay una mesa abierta. Un boton permanente de
          "continuar jugando" que muchas veces no lleva a ninguna parte es peor
          que no tenerlo: el jugador pulsa, no pasa nada, y deja de confiar en
          los accesos rapidos del lobby. */}
      {miMesa && (
        <button
          onClick={volverAMiMesa}
          className="card w-full flex items-center gap-3 mb-3 text-left hover:border-[#00d26a] transition-all"
        >
          <span className="relative flex h-3 w-3 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00d26a] opacity-60" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-[#00d26a]" />
          </span>
          <span className="flex-1">
            <span className="block text-sm font-semibold text-white">
              Continuar jugando
            </span>
            <span className="block text-[11px] text-[#a0a0b0]">
              Tienes una mesa abierta
            </span>
          </span>
          <span className="text-[#a0a0b0]">→</span>
        </button>
      )}

      {/* ---------------- Freeroll del momento ---------------- */}
      {urgente && (
        <section
          className="rounded-2xl p-4 mb-5 relative overflow-hidden"
          style={{
            background:
              'linear-gradient(135deg, rgba(255,215,0,0.14) 0%, rgba(15,15,26,0.6) 100%)',
            border: '1px solid rgba(255,215,0,0.35)',
          }}
        >
          <div className="flex items-center gap-4">
            <span className="text-3xl">🎁</span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-[#ffd700] font-bold">
                {enCurso ? 'Freeroll en juego' : 'Próximo freeroll'}
              </p>
              <p className="text-sm font-semibold text-white truncate">
                {urgente.inicio ? `A las ${horaLocal(urgente.inicio)}` : 'En punto'} ·{' '}
                {fmtUsdt(urgente.premioUsdt)} USDT
              </p>
              <p className="text-[11px] text-[#a0a0b0]">
                {urgente.inscritos} inscritos · gratis
                {enCurso ? ' · registro tardío' : ''}
              </p>
            </div>

            <div className="text-right shrink-0">
              {urgente.inscrito ? (
                <button
                  onClick={() => onNavigate('freeroll')}
                  className="btn btn-primary px-3 py-2 text-xs"
                >
                  Ver
                </button>
              ) : (
                <button
                  onClick={() => inscribirme(urgente.fieldId)}
                  disabled={ocupado}
                  className="btn btn-gold px-3 py-2 text-xs disabled:opacity-50"
                >
                  {ocupado ? '…' : 'Inscribirme'}
                </button>
              )}
              <p className="text-[9px] text-[#a0a0b0] uppercase tracking-wide mt-1">
                {enCurso ? 'Cierra en' : 'Empieza en'}
              </p>
              <p className="text-lg font-bold text-[#ffd700] tabular-nums">
                {fmtCuenta(segundosHasta(
                  enCurso ? urgente.finRegistro : urgente.inicio,
                  ahora,
                ))}
              </p>
            </div>
          </div>
        </section>
      )}

      {aviso && (
        <div className="bg-[#ff4757]/15 border border-[#ff4757] rounded-xl p-3 mb-4">
          <p className="text-xs text-[#ff8a94]">{aviso}</p>
        </div>
      )}

      {/* ---------------- Pestanas ---------------- */}
      <div
        className="flex gap-1 p-1 rounded-xl mb-4"
        style={{ background: '#151525' }}
      >
        {(
          [
            ['cash', 'Cash'],
            ['freeroll', 'Freerolls'],
            ['torneos', 'Torneos'],
          ] as [Pestana, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setPestana(id)}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${
              pestana === id
                ? 'text-black'
                : 'text-[#a0a0b0] hover:text-white'
            }`}
            style={
              pestana === id
                ? { background: 'linear-gradient(135deg, #00d26a 0%, #00b894 100%)' }
                : undefined
            }
          >
            {label}
          </button>
        ))}
      </div>

      {/* ---------------- Contenido de la pestana ---------------- */}
      {pestana === 'cash' && (
        <div className="space-y-2.5 mb-6 animate-fadeIn">
          {tiers.length === 0 && (
            <div className="card text-center py-6">
              <div className="spinner mx-auto" />
            </div>
          )}

          {tiers.map((tier) => (
            <button
              key={tier.id}
              onClick={() => onNavigate('tables')}
              className="card w-full flex items-center gap-4 text-left hover:border-[#00d26a] transition-all"
            >
              <div
                className="w-12 h-12 rounded-xl flex flex-col items-center justify-center shrink-0 text-black"
                style={{
                  background:
                    'linear-gradient(135deg, #00d26a 0%, #00b894 100%)',
                }}
              >
                <span className="font-bold text-sm leading-none">
                  {fmtUsdt(tier.buyIn)}
                </span>
                <span className="text-[8px] font-semibold opacity-75 mt-0.5">
                  USDT
                </span>
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white truncate">
                  {tier.label} · 7-max
                </p>
                <p className="text-[11px] text-[#a0a0b0]">
                  Ciegas {fmtStake(tier.blinds.small)}/{fmtStake(tier.blinds.big)} ·{' '}
                  {tier.stackInBigBlinds} BB
                </p>
              </div>

              <div className="text-right shrink-0">
                <p className="text-[11px] font-semibold text-[#00d26a]">Jugar</p>
                <p className="text-[10px] text-[#a0a0b0]">Elegir mesa</p>
              </div>
            </button>
          ))}

          {tiers.length > 0 && (
            <p className="text-[10px] text-[#6c6c80] text-center pt-1">
              Ring table: juegas con tu saldo y te lo llevas al salir. Sin esperas.
            </p>
          )}
        </div>
      )}

      {pestana === 'freeroll' && (
        <div className="space-y-2.5 mb-6 animate-fadeIn">
          {abierto && (
            <div className="card" style={{ borderColor: 'rgba(255,215,0,0.4)' }}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <span className="badge badge-warning">Abierto</span>
                  <p className="text-lg font-bold text-white mt-2">
                    {abierto.inicio ? horaLocal(abierto.inicio) : '—'}
                  </p>
                  <p className="text-[11px] text-[#a0a0b0]">
                    {abierto.inscritos}/{abierto.tamanoMaximo} inscritos
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[9px] text-[#a0a0b0] uppercase">Empieza en</p>
                  <p className="text-xl font-bold text-[#ffd700] tabular-nums">
                    {fmtCuenta(segundosHasta(abierto.inicio, ahora))}
                  </p>
                  <p className="text-[11px] text-[#00d26a] font-semibold">
                    {fmtUsdt(abierto.premioUsdt)} USDT
                  </p>
                </div>
              </div>

              <button
                onClick={() => onNavigate('freeroll')}
                className="w-full btn btn-outline py-2.5 text-sm"
              >
                Ver freerolls y reparto
              </button>
            </div>
          )}

          {proximos.slice(1, 5).map((slot) => (
            <div
              key={slot.clave}
              className="flex items-center justify-between rounded-xl px-4 py-3"
              style={{ background: '#151525', border: '1px solid #2a2a4a' }}
            >
              <div className="flex items-center gap-3">
                <span>🕐</span>
                <div>
                  <p className="text-sm font-semibold text-white">
                    {horaLocal(slot.inicio)}
                  </p>
                  <p className="text-[10px] text-[#a0a0b0]">
                    {fmtUsdt(slot.premioUsdt)} USDT · gratis
                  </p>
                </div>
              </div>
              <span className="text-[10px] text-[#6c6c80] tabular-nums">
                {fmtCuenta(segundosHasta(slot.inicio, ahora))}
              </span>
            </div>
          ))}

          <button
            onClick={() => onNavigate('freeroll')}
            className="w-full btn btn-gold py-2.5 text-sm"
          >
            Ver todos los freerolls
          </button>
        </div>
      )}

      {pestana === 'torneos' && (
        <div className="space-y-2.5 mb-6 animate-fadeIn">
          <button
            onClick={() => onNavigate('centroll')}
            className="card w-full flex items-center gap-4 text-left hover:border-[#e67e22] transition-all"
          >
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 text-xl"
              style={{
                background: 'linear-gradient(135deg, #e67e22 0%, #d35400 100%)',
              }}
            >
              ⚡
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-white">Centroll</p>
              <p className="text-[11px] text-[#a0a0b0]">
                Entrada de 0,01 USDT · torneo multi-mesa
              </p>
            </div>
            <span className="text-[#a0a0b0]">→</span>
          </button>

          <div className="card flex items-center gap-4 opacity-60">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 text-xl"
              style={{ background: '#2a2a4a' }}
            >
              🏆
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-white">
                Torneos programados
              </p>
              <p className="text-[11px] text-[#a0a0b0]">
                Buy-in y garantizado · próximamente
              </p>
            </div>
            <span className="badge badge-warning">Pronto</span>
          </div>
        </div>
      )}

      {/* ---------------- Accesos rapidos ---------------- */}
      <div className="grid grid-cols-4 gap-2.5 mb-6">
        {(
          [
            ['profile', '👤', 'Perfil'],
            ['vip', '👑', 'VIP'],
            ['referrals', '👥', 'Invitar'],
            ['achievements', '🎖️', 'Logros'],
          ] as [Page, string, string][]
        ).map(([page, emoji, label]) => (
          <button
            key={page}
            onClick={() => onNavigate(page)}
            className="rounded-xl py-3 flex flex-col items-center gap-1.5 hover:border-[#00d26a] transition-all"
            style={{ background: '#151525', border: '1px solid #2a2a4a' }}
          >
            <span className="text-lg">{emoji}</span>
            <span className="text-[10px] text-[#a0a0b0]">{label}</span>
          </button>
        ))}
      </div>

      {/* ---------------- Actividad ---------------- */}
      <h2 className="text-[#a0a0b0] text-xs uppercase tracking-wide mb-3">
        Mi actividad
      </h2>
      <div className="grid grid-cols-3 gap-3 mb-6">
        <Stat label="Manos" value={stats?.handsPlayed ?? 0} color="#00d26a" />
        <Stat label="Ganadas" value={stats?.handsWon ?? 0} color="#ffd700" />
        <Stat
          label="Freerolls"
          value={stats?.freerollsPlayed ?? 0}
          color="#3498db"
        />
      </div>

      <div className="card flex items-start gap-3">
        <span className="text-lg">🔒</span>
        <div>
          <p className="text-sm font-semibold text-white mb-1">
            Juego responsable
          </p>
          <p className="text-xs text-[#a0a0b0] leading-relaxed">
            Los retiros se procesan en 24-72 h. Si deja de ser divertido, tómate
            un descanso. Solo para mayores de 18 años.
          </p>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="card text-center p-4">
      <p className="text-2xl font-bold" style={{ color }}>
        {value}
      </p>
      <p className="text-[10px] text-[#a0a0b0]">{label}</p>
    </div>
  );
}
