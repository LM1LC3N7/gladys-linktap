# LinkTap

Intégration Gladys Assistant non officielle pour les programmateurs
d'arrosage **LinkTap** (TapLinker, ValveLinker) appairés à une passerelle
LinkTap (GW-02, GW-01), par l'**API HTTP locale** de la passerelle : pas de
cloud LinkTap, pas de compte. Sans lien avec LinkTap.

**Jamais testé avec un vrai appareil** : construite d'après l'intégration
Home Assistant `linktap_local_http_component` (0.8.9) et la description du
protocole LinkTap. Merci de signaler ce qui marche et ce qui ne marche pas.

## Ce que vous obtenez

Un appareil par programmateur, avec :

- **Arrosage en cours** (oui/non) et **Temps d'arrosage restant** (secondes) ;
- avec un débitmètre : **Débit** (m³/h) et **Volume de cet arrosage**
  (litres ; une passerelle réglée en gallons est convertie, gallon US) ;
- **Batterie** (%), **Signal radio** (%), **Reliée à la passerelle** ;
- **Programme d'arrosage en pause** ;
- les alertes : débit anormalement élevé, débit anormalement faible, coupure
  d'eau, programmateur tombé, vanne qui n'a pas pu se fermer ;
- trois boutons : **Démarrer l'arrosage**, **Arrêter l'arrosage**, **Mettre
  le programme d'arrosage en pause**.

L'arrosage n'est jamais un interrupteur : un « allume/éteins tout » d'un
assistant vocal, de HomeKit ou d'une scène sur les interrupteurs ne peut pas
ouvrir une vanne.

Un programmateur que la passerelle ne joint plus par radio publie seulement
« Reliée à la passerelle : non » : ses autres valeurs, gardées par la
passerelle, sont anciennes.

## Mise en route

1. Ouvrez la page web de la passerelle (son adresse IP dans votre box) et
   activez son **API HTTP locale** (Local HTTP API). Micrologiciel G609 ou
   plus récent pour une GW-02, S609 pour une GW-01.
2. Donnez à la passerelle une adresse IP fixe dans votre box.
3. Dans Gladys, ouvrez l'intégration, saisissez l'adresse, enregistrez.
4. Ajoutez les programmateurs depuis l'onglet **Découverte**.

L'API locale n'a pas de mot de passe ni de https : tout appareil de votre
réseau local peut l'utiliser. La passerelle traite **une requête à la fois** :
une seule intégration (Gladys, Home Assistant…) par passerelle, et Gladys
n'envoie jamais deux requêtes en même temps.

## Lectures

La passerelle est lue toutes les 30 s par défaut (de 15 à 600 s), une requête
par programmateur, l'une après l'autre ; jamais plus souvent, même après un
redémarrage, un enregistrement de la configuration ou le bouton « Vérifier la
passerelle », sauf les lectures qui suivent une commande (5, 15, 30 et 60 s
après). En cas d'échec : nouvel essai après 30 s, 1, 2 puis 5 minutes. Si
la passerelle répond « occupée » (HTTP 429 ou 5xx, ou son code 6 ou 8), Gladys
fait une pause de 1 minute à 6 heures, gardée après un redémarrage ; les
arrêts ne la respectent pas.

Un programmateur que la passerelle ne connaît pas ou dont la réponse est
illisible n'empêche pas la lecture des autres. Si une autre passerelle répond
à l'adresse, le statut le dit, et les commandes des programmateurs de
l'ancienne passerelle sont refusées.

## Démarrer

- **Démarrer ouvre une vanne : c'est désactivé par défaut.** Activez
  **Autoriser le démarrage d'un arrosage** pour utiliser le bouton Démarrer.
  Sans cela, le tableau de bord, les scènes et les assistants vocaux peuvent
  seulement lire, arrêter et mettre le programme en pause. Une configuration
  enregistrée s'applique aux commandes tout de suite (une option décochée
  bloque les démarrages dès cet instant, même pendant une lecture).
- Gladys lit d'abord le programmateur : déjà en arrosage, rien n'est envoyé
  (l'arrosage n'est jamais prolongé).
- L'arrosage dure la durée réglée (15 minutes par défaut, **120 minutes au
  plus**, borne appliquée par Gladys) ; elle part dans la commande et le
  programmateur referme seul la vanne à la fin. Gladys n'envoie jamais un
  arrosage au volume.
- Refusé, rien envoyé : option désactivée ; adresse de la configuration qui
  n'est pas celle de la passerelle du programmateur ; pause demandée par la
  passerelle ; fichier `/data/linktap.json` illisible ou démarrage impossible
  à y enregistrer ; autre commande du même programmateur en attente ;
  démarrage du même programmateur parti il y a moins d'une minute et pas
  encore vu à la lecture (« réessayez dans une minute ») ; état du
  programmateur illisible ou programmateur non relié par radio ; annulé par un
  arrêt du programmateur ; configuration changée (autre adresse) entre-temps ;
  pas parti dans les 10 s après le clic.
- La passerelle traite une requête à la fois : un démarrage derrière d'autres
  requêtes (une scène qui démarre cinq programmateurs) peut partir jusqu'à
  10 s après le clic ; Gladys répond alors « en file », et s'il ne part pas à
  temps (ou s'il est refusé), le statut le dit. Un arrêt du même programmateur
  l'annule tant qu'il n'est pas parti.
- Le succès n'est répondu que si une lecture faite après montre le
  programmateur en arrosage ; sinon « envoyé, sans confirmation », puis de
  nouvelles lectures à 5, 15, 30 et 60 s.

## Arrêter

Arrêter ne demande aucune autorisation et n'est **jamais bloqué** par
l'option, une pause de la passerelle, un démarrage récent, une configuration
pas encore lue depuis Gladys, ni par une lecture en cours : l'arrêt passe
devant toutes les autres requêtes ; la requête en cours est coupée pour le
laisser partir si elle est muette depuis 1 s, ou si l'arrêt attend depuis
1,5 s. Il annule le démarrage du même programmateur pas encore envoyé. Juste
après un redémarrage, un arrêt fonctionne avant même que Gladys ait donné la
configuration.

L'arrêt est **refusé sans envoi** seulement :

- si le programmateur n'a jamais été lu par cette intégration (il n'est pas
  connu) ;
- si la passerelle du programmateur n'a plus d'adresse connue (une autre
  passerelle a répondu à son adresse) ;
- si la valeur du bouton n'est pas un appui.

Il est **envoyé puis refusé par la passerelle** si elle ne connaît pas le
programmateur (rien à arrêter, rien n'est renvoyé), ou si elle répond une
autre erreur (format, paramètre, commande non prise en charge).

Si la passerelle **ne le prend pas** (pas de connexion, passerelle occupée,
erreur HTTP comme un 404, autre passerelle à l'adresse), il est réessayé
250 ms après dans ses 3 s, puis **toutes les 10 s (chaque minute après
5 minutes) et à chaque lecture qui atteint la passerelle, sans fin jusqu'à ce
qu'elle le prenne**, même pendant une pause et après un redémarrage. Ces essais
ne sont jamais comptés : une réponse qui montre que rien n'a été appliqué
(occupée, 404) n'est pas un renvoi.

Après un arrêt pris par la passerelle, une lecture qui montre encore **le
même arrosage** en cours (partie au moins 4 s après la prise : la radio a
besoin de temps) le renvoie : 3 renvois au plus, chacun compté une fois (quand
la passerelle le prend, ou s'il est parti sans réponse). Seules les lectures
parties après le clic comptent, et chacune est datée de son départ : la
passerelle mesure pendant la requête, jusqu'à 3 s avant sa réponse.

Un autre arrosage n'est pas coupé par un renvoi **quand Gladys peut prouver
que c'en est un autre** : sa durée diffère de celle de l'arrosage arrêté, son
temps restant a augmenté, ou il est plus jeune que l'arrêt (son temps écoulé,
durée moins temps restant, est plus court de plus de 1,5 s que le temps entre
le clic et le départ de la lecture ; seulement une fois la passerelle vue en
train de décompter le temps restant). **Dans le doute, l'arrêt l'emporte** :
un arrosage relancé par l'application LinkTap quelques secondes après l'arrêt
peut être coupé par un renvoi, par exemple s'il a la même durée et que le
temps restant de la passerelle ne décompte pas (ou n'est pas donné), ou si
Gladys n'avait pas lu l'arrosage arrêté avant le clic et que la première
lecture qui suit le montre déjà relancé (elle sert alors de référence, quelle
que soit sa durée).

La surveillance d'un arrêt n'est levée que par :

- une lecture qui montre le programmateur arrêté, suivie d'un arrosage lu
  deux fois de suite (lancé ailleurs), ou un autre arrosage lu deux fois de
  suite ;
- un démarrage depuis Gladys avec l'option : qui part, ou qui trouve le
  programmateur déjà en arrosage ;
- la passerelle qui répond ne pas connaître le programmateur.

Elle n'est **jamais levée par le temps seul**. Le statut signale un arrêt pas
encore pris, et un arrosage qui continue après trois renvois.

## Mettre le programme en pause

Le bouton met le programme d'arrosage du programmateur en pause pour la durée
réglée (24 h par défaut, de 1 à 240 h). Il ne demande pas l'option de
démarrage. Gladys lit d'abord le programmateur : déjà en pause, rien n'est
envoyé (une seconde pause peut désactiver le programme, défaut connu de
LinkTap). Après une pause envoyée, une autre est refusée jusqu'à ce qu'une
lecture montre le programme en pause, 10 minutes au plus (gardé après un
redémarrage). Refusé, rien envoyé : état illisible, programmateur non relié,
micrologiciel qui ne dit pas si le programme est en pause, pause demandée par
la passerelle, adresse de la configuration qui n'est pas celle de sa
passerelle, `/data` non inscriptible, configuration changée entre-temps, pas
partie dans les 10 s après le clic. Reprendre le programme se fait dans
l'application LinkTap.

## Bouton « Vérifier la passerelle »

Affiche l'identifiant de la passerelle, son micrologiciel, le nombre de
programmateurs et l'âge de la dernière lecture, ou la dernière erreur. Il ne
relit pas plus vite que l'intervalle.

## Fichier /data

`/data/linktap.json` garde la passerelle et ses programmateurs, la pause
demandée par la passerelle, les démarrages et arrêts en cours de surveillance
et l'heure de la dernière lecture. Aucun secret : l'API locale n'en a pas.
S'il existe mais est illisible, Gladys n'y écrit plus rien (il n'est jamais
écrasé), refuse les démarrages et continue à lire et arrêter.
