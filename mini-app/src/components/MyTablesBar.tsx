import { useEffect, useState } from 'react';
import type { MyTable } from '../lib/types';
import { fmtCuenta, segundosHasta } from '../lib/tiempo';
import { fmtUsdt } from './Balance';

interface Props {
  tables: MyTable[];
  onOpen: (tableId: string) => void;
}

/**
 * SELECTOR MULTI-MESA
 * ===================
 *
 * Varias mesas abiertas a la vez se pierden si el jugador tiene que volver al
 * lobby para cambiar. Esta barra vive encima de la navegacion, muestra el
 * stack y el tiempo que queda, y entra a la mesa con un toque.
 *
 * La linea superior es el reloj: verde cuando te toca actuar, azul cuando la
 * mano sigue y gris cuando la mesa esta en pausa entre manos. No es decorativa:
 * es la unica forma de saber, sin abrir la mesa, si estas perdiendo el turno.
 */
export function MyTablesBar({ tables, onOpen }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (tables.length === 0) return null;

  return (
    <div className="sticky top-14 z-30 border-b border-[#2a2a4a] bg-[#0f0f1a]/95 backdrop-blur">
      <div className="max-w-md mx-auto px-2 py-2 flex gap-2 overflow-x-auto">
        {tables.map((table) => {
          const enMano = ['preflop', 'flop', 'turn', 'river'].includes(table.phase);
          const deadline = table.isMyTurn ? table.turnEndsAt : table.nextHandAt;
          const segundos = deadline ? segundosHasta(deadline, now) : 0;
          const total =
            table.isMyTurn && table.turnStartedAt && table.turnEndsAt
              ? Math.max(
                  1,
                  (new Date(table.turnEndsAt).getTime() -
                    new Date(table.turnStartedAt).getTime()) /
                    1000,
                )
              : 1;
          const restante = Math.min(1, segundos / total);
          const color = table.isMyTurn
            ? '#00d26a'
            : enMano
              ? '#3498db'
              : table.nextHandAt
                ? '#ffd700'
                : '#3a3a5a';

          return (
            <button
              key={table.tableId}
              onClick={() => onOpen(table.tableId)}
              className="relative shrink-0 w-[148px] rounded-xl overflow-hidden text-left"
              style={{ background: '#16213e', border: '1px solid #2a2a4a' }}
              title={`${table.label} · ${table.displayChips} ${table.mode}`}
            >
              <div className="h-1 w-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
                <div
                  className="h-1 transition-all"
                  style={{ width: `${restante * 100}%`, background: color }}
                />
              </div>
              <div className="p-2.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[10px] font-bold text-white truncate">
                    {table.label}
                  </span>
                  <span className="text-[9px] text-[#a0a0b0]">#{table.seatIndex + 1}</span>
                </div>
                <div className="flex items-baseline justify-between mt-1">
                  <span className="text-sm font-bold" style={{ color }}>
                    {table.mode === 'USDT'
                      ? `${fmtUsdt(table.displayChips)} USDT`
                      : `${table.displayChips.toLocaleString('es-ES')} pts`}
                  </span>
                  <span className="text-[9px] text-[#a0a0b0]">
                    {table.isMyTurn
                      ? `⏱ ${fmtCuenta(segundos)}`
                      : table.nextHandAt
                        ? `▶ ${fmtCuenta(segundos)}`
                        : table.phase === 'idle'
                          ? 'espera'
                          : 'mano'}
                  </span>
                </div>
                <div className="text-[9px] text-[#a0a0b0] mt-0.5 truncate">
                  {table.mode === 'USDT'
                    ? `Bote ${fmtUsdt(table.displayPot)} · ${table.smallBlindUsdt}/${table.bigBlindUsdt}`
                    : `Nivel ${table.blindLevel} · bote ${table.displayPot}`}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
