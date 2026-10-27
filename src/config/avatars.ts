/**
 * CATÁLOGO DE AVATARES
 * ====================
 *
 * El avatar es una clave corta que se guarda en el usuario y se copia al
 * asiento cuando se sienta. No es una URL: si lo fuera, el jugador podría
 * apuntar a una imagen externa (seguimiento, contenido ajeno) y la mesa
 * dependería de que ese servidor esté vivo. Con un catálogo cerrado, la mesa
 * pinta siempre lo mismo y el servidor puede validar la elección.
 *
 * Los avatares de miembro son un beneficio del 3-Bet Club. No se compran por
 * separado: se desbloquean mientras la membresía esté activa. Si la membresía
 * vence, el avatar vuelve al catálogo común, pero no se borra la elección: al
 * renovar, el jugador recupera el que tenía.
 *
 * Los emojis se renderizan con la fuente del sistema. No se usan imágenes de
 * terceros para no arrastrar licencias de arte a la obra combinada.
 */

export interface AvatarOption {
  id: string;
  emoji: string;
  label: string;
  memberOnly: boolean;
}

export const AVATARS: readonly AvatarOption[] = [
  { id: 'fox', emoji: '🦊', label: 'Zorro', memberOnly: false },
  { id: 'wolf', emoji: '🐺', label: 'Lobo', memberOnly: false },
  { id: 'lion', emoji: '🦁', label: 'León', memberOnly: false },
  { id: 'tiger', emoji: '🐯', label: 'Tigre', memberOnly: false },
  { id: 'panda', emoji: '🐼', label: 'Panda', memberOnly: false },
  { id: 'eagle', emoji: '🦅', label: 'Águila', memberOnly: false },
  { id: 'cobra', emoji: '🐍', label: 'Cobra', memberOnly: false },
  { id: 'shark', emoji: '🦈', label: 'Tiburón', memberOnly: false },
  { id: 'joker', emoji: '🃏', label: 'Comodín', memberOnly: true },
  { id: 'crown', emoji: '👑', label: 'Corona', memberOnly: true },
  { id: 'diamond', emoji: '💎', label: 'Diamante', memberOnly: true },
  { id: 'rocket', emoji: '🚀', label: 'Cohete', memberOnly: true },
  { id: 'skull', emoji: '💀', label: 'Calavera', memberOnly: true },
  { id: 'dragon', emoji: '🐉', label: 'Dragón', memberOnly: true },
];

export const DEFAULT_AVATAR = 'fox';

const POR_ID = new Map(AVATARS.map((a) => [a.id, a]));

/** Devuelve el avatar o `undefined` si la clave no existe. */
export function getAvatar(id?: string | null): AvatarOption | undefined {
  if (!id) return undefined;
  return POR_ID.get(id);
}

/** Avatar para pintar: si la clave es desconocida, cae al común. */
export function avatarForDisplay(id?: string | null): AvatarOption {
  return getAvatar(id) ?? POR_ID.get(DEFAULT_AVATAR)!;
}

/** ¿Puede este jugador elegir ese avatar? */
export function canUseAvatar(id: string, hasMembership: boolean): boolean {
  const avatar = getAvatar(id);
  if (!avatar) return false;
  return !avatar.memberOnly || hasMembership;
}

/** El catálogo que ve la interfaz, con el bloqueo ya resuelto. */
export function avatarCatalog(hasMembership: boolean) {
  return AVATARS.map((a) => ({
    ...a,
    unlocked: !a.memberOnly || hasMembership,
  }));
}

/**
 * Avatar de un asiento automático.
 *
 * Determinista por nombre para que el mismo rival conserve su cara entre
 * manos de la misma sesión. Solo usa avatares comunes: un asiento automático
 * con corona insinuaría una membresía que no existe.
 */
export function botAvatarFor(name: string): string {
  const comunes = AVATARS.filter((a) => !a.memberOnly);
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return comunes[Math.abs(hash) % comunes.length].id;
}
