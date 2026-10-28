// -----------------------------------------------------------------------------
// The texts shown to the user (feature names, connection status, action
// answers, command refusals), in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });

/** The text of a `{ en, fr }` in a language (French when missing). */
export const word = (text, language) => text?.[language] ?? text?.fr ?? String(text ?? '');

/** `{ en, fr }` -> one text with both, for the status and the action answers. */
export const join = (parts, separator = ' ') => ({
  en: parts.map((p) => p.en).join(separator),
  fr: parts.map((p) => p.fr).join(separator),
});

export const FEATURE_NAMES = {
  watering: both('Watering', 'Arrosage en cours'),
  remaining: both('Watering time left', "Temps d'arrosage restant"),
  flow: both('Flow', 'Débit'),
  volume: both('Volume of this watering', 'Volume de cet arrosage'),
  battery: both('Battery', 'Batterie'),
  signal: both('Radio signal', 'Signal radio'),
  rfLinked: both('Linked to the gateway', 'Reliée à la passerelle'),
  planPaused: both('Watering plan paused', "Programme d'arrosage en pause"),
  high_flow: both('Alert: unusually high flow', 'Alerte : débit anormalement élevé'),
  low_flow: both('Alert: unusually low flow', 'Alerte : débit anormalement faible'),
  water_cut: both('Alert: water cut off', "Alerte : coupure d'eau"),
  fall: both('Alert: timer fallen', 'Alerte : programmateur tombé'),
  valve_failure: both('Alert: valve failed to close', "Alerte : la vanne n'a pas pu se fermer"),
  start: both('Start watering', "Démarrer l'arrosage"),
  stop: both('Stop watering', "Arrêter l'arrosage"),
  pausePlan: both('Pause the watering plan', "Mettre le programme d'arrosage en pause"),
};

const KINDS = {
  timeout: both('no answer in time', 'pas de réponse à temps'),
  unreachable: both('unreachable', 'injoignable'),
  busy: both('busy, asked for a pause', 'occupée, pause demandée'),
  http: both('unexpected HTTP answer', 'réponse HTTP inattendue'),
  invalid: both('not a LinkTap answer', 'pas une réponse LinkTap'),
  tooLarge: both('answer too large', 'réponse trop grande'),
  protocol: both('request refused (protocol)', 'requête refusée (protocole)'),
  unknownTimer: both(
    'water timer unknown to the gateway',
    'programmateur inconnu de la passerelle',
  ),
  otherGateway: both('another gateway answers', 'une autre passerelle répond'),
  conflict: both('conflict with the watering plan', "conflit avec le programme d'arrosage"),
  cut: both('cut by a stop', 'coupée par un arrêt'),
  late: both('the gateway was not free in time', "la passerelle n'était pas libre à temps"),
  cancelled: both('cancelled', 'annulée'),
  error: both('error', 'erreur'),
};
export const kindText = (kind) => KINDS[kind] ?? KINDS.error;

export const T = {
  noAddress: both(
    'No LinkTap gateway yet: type its IP address in the configuration (its local HTTP API must be enabled).',
    'Aucune passerelle LinkTap pour le moment : saisissez son adresse IP dans la configuration (son API HTTP locale doit être activée).',
  ),
  invalidAddress: (text) => both(`Not an address: ${text}.`, `Ce n'est pas une adresse : ${text}.`),
  waiting: both(
    'Waiting for the first read of the gateway.',
    'En attente de la première lecture de la passerelle.',
  ),
  restored: (seconds) =>
    both(
      `The gateway answered before the restart; next read within ${seconds} s.`,
      `La passerelle répondait avant le redémarrage ; prochaine lecture sous ${seconds} s.`,
    ),
  ok: (name, timers, watering) =>
    both(
      `Connected to ${name}: ${timers} water timer(s)${watering > 0 ? `, ${watering} watering` : ''}.`,
      `Connecté à ${name} : ${timers} programmateur(s)${watering > 0 ? `, ${watering} en arrosage` : ''}.`,
    ),
  timersUnreachable: (count) =>
    both(
      `${count} water timer(s) not read (unlinked or unknown to the gateway).`,
      `${count} programmateur(s) non lu(s) (non relié(s) ou inconnu(s) de la passerelle).`,
    ),
  failed: (kind) => both(`Gateway: ${kindText(kind).en}.`, `Passerelle : ${kindText(kind).fr}.`),
  notGateway: both(
    'The answer at this address is not a LinkTap gateway (is its local HTTP API enabled?).',
    "La réponse à cette adresse n'est pas celle d'une passerelle LinkTap (son API HTTP locale est-elle activée ?).",
  ),
  moved: (previous, next) =>
    both(
      `Gateway ${previous} no longer answers at this address, ${next} does.`,
      `La passerelle ${previous} ne répond plus à cette adresse, ${next} y répond.`,
    ),
  paused: both('Paused at the request of the gateway.', 'En pause à la demande de la passerelle.'),
  wateringOff: both(
    'Starting a watering is off (configuration).',
    "Le démarrage d'un arrosage est désactivé (configuration).",
  ),
  dataBroken: both(
    'The file /data/linktap.json cannot be read: nothing is written to it, starts are refused.',
    "Le fichier /data/linktap.json est illisible : rien n'y est écrit, les démarrages sont refusés.",
  ),
  configUnreadable: (seconds) =>
    both(
      `The configuration could not be read from Gladys; next try in ${seconds} s.`,
      `La configuration n'a pas pu être lue depuis Gladys ; nouvel essai dans ${seconds} s.`,
    ),
  stopUnconfirmed: (names) =>
    both(
      `Still watering after a stop: ${names}.`,
      `Arrosage toujours en cours après un arrêt : ${names}.`,
    ),
  /** `reason` is a whole sentence (a refusal, or "Not sent (…)."). */
  lateOutcome: (name, kind, reason) =>
    kind === 'refused'
      ? both(`Start of ${name}: ${reason.en}`, `Démarrage de ${name} : ${reason.fr}`)
      : kind === 'pauseNotSent'
        ? both(
            `Pause of the plan of ${name}: ${reason.en}`,
            `Pause du programme de ${name} : ${reason.fr}`,
          )
        : both(`Start of ${name}: ${reason.en}`, `Démarrage de ${name} : ${reason.fr}`),
  noTimerRead: both(
    'No water timer could be read (unlinked or unknown to the gateway).',
    "Aucun programmateur n'a pu être lu (non relié ou inconnu de la passerelle).",
  ),
  stopPending: (names) =>
    both(
      `Stop not taken by the gateway yet, sent again every 10 s (every minute after 5 minutes): ${names}.`,
      `Arrêt pas encore pris par la passerelle, renvoyé toutes les 10 s (chaque minute après 5 minutes) : ${names}.`,
    ),
  check: {
    none: both('No address in the configuration.', "Pas d'adresse dans la configuration."),
    pending: both(
      'Not read yet (never sooner than the refresh interval).',
      "Pas encore lue (jamais plus vite que l'intervalle de rafraîchissement).",
    ),
    ok: (id, version, timers, age) =>
      both(
        `Gateway ${id}${version ? `, firmware ${version}` : ''}: ${timers} water timer(s), read ${age} s ago.`,
        `Passerelle ${id}${version ? `, micrologiciel ${version}` : ''} : ${timers} programmateur(s), lue il y a ${age} s.`,
      ),
    failed: (kind, age) =>
      both(
        `Last read ${age} s ago: ${kindText(kind).en}.`,
        `Dernière lecture il y a ${age} s : ${kindText(kind).fr}.`,
      ),
    interval: (seconds) =>
      both(`Read every ${seconds} s at most.`, `Lue toutes les ${seconds} s au plus.`),
  },
};

export const ERRORS = {
  unknownDevice: both(
    'This water timer is not known (any longer) at the gateway of the configuration.',
    "Ce programmateur n'est pas (plus) connu à la passerelle de la configuration.",
  ),
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both('Unexpected value for a button.', 'Valeur inattendue pour un bouton.'),
  wateringDisabled: both(
    'Starting a watering is off: allow it in the configuration of the integration.',
    "Le démarrage d'un arrosage est désactivé : autorisez-le dans la configuration de l'intégration.",
  ),
  noAddress: both(
    'No gateway address in the configuration.',
    "Pas d'adresse de passerelle dans la configuration.",
  ),
  dataBroken: both(
    'Refused: /data/linktap.json cannot be read, the start could not be recorded.',
    "Refusé : /data/linktap.json est illisible, le démarrage n'a pas pu être enregistré.",
  ),
  saveFailed: both(
    'Refused, nothing sent: the command could not be recorded in /data.',
    "Refusé, rien envoyé : la commande n'a pas pu être enregistrée dans /data.",
  ),
  justStarted: both(
    'A start of this water timer was just sent: try again in a minute.',
    'Un démarrage de ce programmateur vient de partir : réessayez dans une minute.',
  ),
  pending: both(
    'A command of this water timer is already waiting.',
    'Une commande de ce programmateur attend déjà.',
  ),
  blocked: both(
    'Refused, nothing sent: the gateway asked for a pause.',
    'Refusé, rien envoyé : la passerelle a demandé une pause.',
  ),
  tooSlow: both(
    'Not sent: the gateway was not free in time.',
    "Non envoyé : la passerelle n'était pas libre à temps.",
  ),
  cancelled: both('Cancelled by a stop, nothing sent.', 'Annulé par un arrêt, rien envoyé.'),
  configChanged: both(
    'Cancelled, nothing sent: the configuration changed.',
    'Annulé, rien envoyé : la configuration a changé.',
  ),
  queued: both(
    'Queued behind other requests (the gateway handles one at a time): it may leave up to 10 s after the click, otherwise nothing is sent and the status says so. A stop of the timer cancels it.',
    "En file derrière d'autres requêtes (la passerelle en traite une à la fois) : elle peut partir jusqu'à 10 s après le clic, sinon rien n'est envoyé et le statut le dit. Un arrêt du programmateur l'annule.",
  ),
  justPaused: both(
    'A pause of the plan of this water timer was just sent and is not seen yet: try again in a few minutes.',
    "Une pause du programme de ce programmateur vient de partir et n'est pas encore visible : réessayez dans quelques minutes.",
  ),
  notSent: (reason) => both(`Not sent (${reason}).`, `Non envoyé (${reason}).`),
  refused: (reason) =>
    both(`Refused by the gateway (${reason}).`, `Refusé par la passerelle (${reason}).`),
  sentUnconfirmed: (reason) =>
    both(`Sent, without confirmation (${reason}).`, `Envoyé, sans confirmation (${reason}).`),
  notSeen: both('not seen yet on a read', 'pas encore vu à la lecture'),
  noAnswer: both('no answer yet', 'pas encore de réponse'),
  unknownState: both(
    'Refused, nothing sent: the state of the water timer could not be read just now.',
    "Refusé, rien envoyé : l'état du programmateur n'a pas pu être lu à l'instant.",
  ),
  stopNotSent: (reason) =>
    both(
      `Stop not taken yet (${reason}): Gladys sends it again every 10 s (every minute after 5 minutes) until the gateway takes it.`,
      `Arrêt pas encore pris (${reason}) : Gladys le renvoie toutes les 10 s (chaque minute après 5 minutes) jusqu'à ce que la passerelle le prenne.`,
    ),
};
