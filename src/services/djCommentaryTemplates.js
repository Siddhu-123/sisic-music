// DJ commentary templates for set-intro, link, and callback.
export const TEMPLATES = [
  {
    "id": "set-01",
    "kind": "set-intro",
    "needs": [
      "theme",
      "count",
      "mood"
    ],
    "text": "Here we go: a set about {theme}, {count} songs of {mood} music, start to finish."
  },
  {
    "id": "set-02",
    "kind": "set-intro",
    "needs": [
      "artist",
      "count"
    ],
    "text": "Kicking things off with {artist}, {count} tracks deep, no detours."
  },
  {
    "id": "set-03",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "{artist} to start, and {title} not far behind."
  },
  {
    "id": "set-04",
    "kind": "set-intro",
    "needs": [
      "timeOfDay",
      "count",
      "mood"
    ],
    "text": "Good {timeOfDay} to you, with {count} songs that stay {mood}."
  },
  {
    "id": "set-05",
    "kind": "set-intro",
    "needs": [
      "theme",
      "artist",
      "count"
    ],
    "text": "This stretch is about {theme}, and {artist} is where it begins, {count} songs end to end."
  },
  {
    "id": "set-06",
    "kind": "set-intro",
    "needs": [
      "title"
    ],
    "text": "Up first, {title}."
  },
  {
    "id": "set-07",
    "kind": "set-intro",
    "needs": [
      "timeOfDay",
      "count",
      "mood"
    ],
    "text": "Welcome in, {timeOfDay} crowd: {count} songs, all of it {mood}."
  },
  {
    "id": "set-08",
    "kind": "set-intro",
    "needs": [
      "artist",
      "playCount"
    ],
    "text": "{artist} again, for the {playCount}th time, and still no complaints."
  },
  {
    "id": "set-09",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "Starting with {title} by {artist}, and staying right here a while."
  },
  {
    "id": "set-10",
    "kind": "set-intro",
    "needs": [
      "theme",
      "count",
      "tempoRelation"
    ],
    "text": "A set built around {theme}: {count} tracks, tempo {tempoRelation} throughout."
  },
  {
    "id": "set-11",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title",
      "mood"
    ],
    "text": "Set list: {artist}, then {title}, and the rest of the {mood} bunch."
  },
  {
    "id": "set-12",
    "kind": "set-intro",
    "needs": [
      "lastPlayedDaysAgo",
      "artist"
    ],
    "text": "It has been {lastPlayedDaysAgo} days since {artist} sat in this chair."
  },
  {
    "id": "set-13",
    "kind": "set-intro",
    "needs": [
      "theme",
      "count",
      "mood"
    ],
    "text": "Now {theme}, {count} songs, and a {mood} headspace."
  },
  {
    "id": "set-14",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "{title} opens, {artist} answers."
  },
  {
    "id": "set-15",
    "kind": "set-intro",
    "needs": [
      "timeOfDay",
      "artist",
      "count"
    ],
    "text": "For a {timeOfDay} start, {artist} first and {count} songs after."
  },
  {
    "id": "set-16",
    "kind": "set-intro",
    "needs": [
      "keyRelation",
      "count",
      "mood"
    ],
    "text": "Keys {keyRelation} all the way down, {count} songs, one temperature: {mood}."
  },
  {
    "id": "set-17",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "Two songs, one mood: {artist}, then {title}."
  },
  {
    "id": "set-18",
    "kind": "set-intro",
    "needs": [
      "title"
    ],
    "text": "{title} opens us, which is about the right place to start."
  },
  {
    "id": "set-19",
    "kind": "set-intro",
    "needs": [
      "theme",
      "count",
      "mood"
    ],
    "text": "The theme here is {theme}, {count} songs, and a {mood} stretch throughout."
  },
  {
    "id": "set-20",
    "kind": "set-intro",
    "needs": [
      "firstTime",
      "artist",
      "title"
    ],
    "text": "{firstTime} pick from {artist} opens this set, and {title} follows."
  },
  {
    "id": "set-21",
    "kind": "set-intro",
    "needs": [
      "artist"
    ],
    "text": "Handing the first song to {artist}."
  },
  {
    "id": "set-22",
    "kind": "set-intro",
    "needs": [
      "count",
      "tempoRelation"
    ],
    "text": "The set runs {count} deep, tempo {tempoRelation} from first bar to last."
  },
  {
    "id": "set-23",
    "kind": "set-intro",
    "needs": [
      "mood",
      "artist",
      "count"
    ],
    "text": "A {mood} one from {artist} to start, and {count} of them after that."
  },
  {
    "id": "set-24",
    "kind": "set-intro",
    "needs": [
      "artist"
    ],
    "text": "Straight into {artist}!"
  },
  {
    "id": "set-25",
    "kind": "set-intro",
    "needs": [
      "mood",
      "count",
      "prevArtist"
    ],
    "text": "A {mood} set of {count} songs, coming in on the heels of {prevArtist}."
  },
  {
    "id": "set-26",
    "kind": "set-intro",
    "needs": [
      "title",
      "artist",
      "mood"
    ],
    "text": "{title}, {artist}, and the rest of the {mood} run."
  },
  {
    "id": "set-27",
    "kind": "set-intro",
    "needs": [
      "timeOfDay",
      "count",
      "theme"
    ],
    "text": "Here for a {timeOfDay} stretch: {count} songs about {theme}."
  },
  {
    "id": "set-28",
    "kind": "set-intro",
    "needs": [
      "artist"
    ],
    "text": "And we are off, with {artist} leading the way."
  },
  {
    "id": "set-29",
    "kind": "set-intro",
    "needs": [
      "keyRelation",
      "tempoRelation",
      "count",
      "mood"
    ],
    "text": "Keys {keyRelation}, tempo {tempoRelation}, {count} songs of {mood} music."
  },
  {
    "id": "set-30",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "{artist} on the first slot, {title} on the second."
  },
  {
    "id": "set-31",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "{artist} early, {title} before you know it."
  },
  {
    "id": "set-32",
    "kind": "set-intro",
    "needs": [
      "lastPlayedDaysAgo",
      "artist"
    ],
    "text": "It has been {lastPlayedDaysAgo} days, and tonight {artist} gets the first word."
  },
  {
    "id": "set-33",
    "kind": "set-intro",
    "needs": [
      "theme",
      "count",
      "mood"
    ],
    "text": "Warming up with {theme}: {count} songs on the way, {mood} where I can."
  },
  {
    "id": "set-34",
    "kind": "set-intro",
    "needs": [
      "title",
      "artist",
      "mood"
    ],
    "text": "{title} leads, {artist} follows, and we keep it {mood}."
  },
  {
    "id": "set-35",
    "kind": "set-intro",
    "needs": [
      "timeOfDay",
      "count",
      "artist"
    ],
    "text": "A {timeOfDay} set, {count} songs, opening on {artist}."
  },
  {
    "id": "set-36",
    "kind": "set-intro",
    "needs": [
      "firstTime",
      "artist",
      "count"
    ],
    "text": "{firstTime} track from {artist} to open, then {count} songs to settle into."
  },
  {
    "id": "set-37",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "Not much to say: {artist} plays first, {title} is next."
  },
  {
    "id": "set-38",
    "kind": "set-intro",
    "needs": [
      "theme",
      "count",
      "mood"
    ],
    "text": "Around {theme}, {count} songs, {mood} from top to bottom."
  },
  {
    "id": "set-39",
    "kind": "set-intro",
    "needs": [
      "tempoRelation",
      "keyRelation",
      "artist"
    ],
    "text": "Tempo {tempoRelation}, keys {keyRelation}, and {artist} right at the front."
  },
  {
    "id": "set-40",
    "kind": "set-intro",
    "needs": [
      "title",
      "count"
    ],
    "text": "Here is {title}, and {count} songs to keep it going."
  },
  {
    "id": "set-41",
    "kind": "set-intro",
    "needs": [
      "prevTitle",
      "prevArtist"
    ],
    "text": "{prevTitle} by {prevArtist} came before, so this set picks up from there."
  },
  {
    "id": "set-42",
    "kind": "set-intro",
    "needs": [
      "artist",
      "count",
      "timeOfDay"
    ],
    "text": "{artist}, {count} songs, and a {timeOfDay} to do it in."
  },
  {
    "id": "set-43",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "Two names, one direction: {artist}, then {title}."
  },
  {
    "id": "set-44",
    "kind": "set-intro",
    "needs": [
      "mood",
      "count",
      "theme"
    ],
    "text": "A {mood} one, {count} of them, all about {theme}."
  },
  {
    "id": "set-45",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title",
      "mood"
    ],
    "text": "{artist} first, {title} second, {mood} the whole way."
  },
  {
    "id": "set-46",
    "kind": "set-intro",
    "needs": [
      "artist",
      "count"
    ],
    "text": "Nothing planned beyond {artist} and {count} songs, which is plenty."
  },
  {
    "id": "set-47",
    "kind": "set-intro",
    "needs": [
      "timeOfDay",
      "theme",
      "count",
      "mood"
    ],
    "text": "Welcome to a {timeOfDay} set: {theme}, {count} songs, {mood} and easy."
  },
  {
    "id": "set-48",
    "kind": "set-intro",
    "needs": [
      "firstTime",
      "artist",
      "count",
      "mood"
    ],
    "text": "{firstTime} moment for {artist}, and then {count} songs of {mood}."
  },
  {
    "id": "set-49",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title",
      "mood"
    ],
    "text": "Setting the table: {artist}, {title}, and a {mood} stretch ahead."
  },
  {
    "id": "set-50",
    "kind": "set-intro",
    "needs": [
      "artist",
      "keyRelation"
    ],
    "text": "{artist} up first, keys {keyRelation} for the whole thing."
  },
  {
    "id": "set-51",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "Set the tone with {artist}, then let {title} have a turn."
  },
  {
    "id": "set-52",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "One song to start, {title}. One to follow, {artist}."
  },
  {
    "id": "set-53",
    "kind": "set-intro",
    "needs": [
      "playCount",
      "artist",
      "title"
    ],
    "text": "{playCount} plays of {artist} in the books, and tonight opens with {title}."
  },
  {
    "id": "set-54",
    "kind": "set-intro",
    "needs": [
      "playCount",
      "artist"
    ],
    "text": "Play number {playCount} for {artist}, and the set starts right here."
  },
  {
    "id": "set-55",
    "kind": "set-intro",
    "needs": [
      "lastPlayedDaysAgo",
      "title"
    ],
    "text": "Quiet for {lastPlayedDaysAgo} days, so {title} opens things up tonight."
  },
  {
    "id": "set-56",
    "kind": "set-intro",
    "needs": [
      "prevTitle",
      "title"
    ],
    "text": "Last up was {prevTitle}, so this set opens with {title}."
  },
  {
    "id": "set-57",
    "kind": "set-intro",
    "needs": [
      "prevTitle",
      "artist",
      "count"
    ],
    "text": "Coming off {prevTitle}, straight into {artist}, {count} songs deep."
  },
  {
    "id": "set-58",
    "kind": "set-intro",
    "needs": [
      "prevArtist",
      "artist",
      "count",
      "mood"
    ],
    "text": "{prevArtist} before this, and {artist} now, {count} songs of {mood}."
  },
  {
    "id": "set-59",
    "kind": "set-intro",
    "needs": [
      "artist",
      "count"
    ],
    "text": "{artist} opens, and I leave the rest of the {count} to the music."
  },
  {
    "id": "set-60",
    "kind": "set-intro",
    "needs": [
      "artist"
    ],
    "text": "Quietly, {artist}."
  },
  {
    "id": "set-61",
    "kind": "set-intro",
    "needs": [
      "title"
    ],
    "text": "And we begin with {title}."
  },
  {
    "id": "set-62",
    "kind": "set-intro",
    "needs": [
      "artist"
    ],
    "text": "{artist}, then we see."
  },
  {
    "id": "set-63",
    "kind": "set-intro",
    "needs": [
      "artist",
      "count",
      "mood"
    ],
    "text": "{mood} from the top, {artist} on the first slot, {count} songs in all."
  },
  {
    "id": "set-64",
    "kind": "set-intro",
    "needs": [
      "artist"
    ],
    "text": "Start here, {artist}."
  },
  {
    "id": "set-65",
    "kind": "set-intro",
    "needs": [
      "title"
    ],
    "text": "{title}, and that is how the set begins."
  },
  {
    "id": "set-66",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "Two names on the opener: {artist} and {title}."
  },
  {
    "id": "set-67",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "{artist} leads, and {title} is right there."
  },
  {
    "id": "set-68",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "Opening slot goes to {artist}, next slot to {title}."
  },
  {
    "id": "set-69",
    "kind": "set-intro",
    "needs": [
      "artist",
      "title"
    ],
    "text": "Nothing fancy tonight: {artist}, {title}, and more."
  },
  {
    "id": "lin-01",
    "kind": "link",
    "needs": [
      "artist"
    ],
    "text": "Now over to {artist}, with a good one in hand."
  },
  {
    "id": "lin-02",
    "kind": "link",
    "needs": [
      "artist"
    ],
    "text": "Give it up for {artist}!"
  },
  {
    "id": "lin-03",
    "kind": "link",
    "needs": [
      "artist"
    ],
    "text": "Something from {artist} to carry the stretch."
  },
  {
    "id": "lin-04",
    "kind": "link",
    "needs": [
      "title"
    ],
    "text": "And this one goes by {title}."
  },
  {
    "id": "lin-05",
    "kind": "link",
    "needs": [
      "title"
    ],
    "text": "Next up, {title}, and it speaks for itself."
  },
  {
    "id": "lin-06",
    "kind": "link",
    "needs": [
      "artist",
      "title"
    ],
    "text": "Straight into {title} by {artist}!"
  },
  {
    "id": "lin-07",
    "kind": "link",
    "needs": [
      "artist",
      "title"
    ],
    "text": "{title}, from {artist}, next."
  },
  {
    "id": "lin-08",
    "kind": "link",
    "needs": [
      "artist"
    ],
    "text": "{artist}, right where the set wants them."
  },
  {
    "id": "lin-09",
    "kind": "link",
    "needs": [
      "title"
    ],
    "text": "{title} closes this stretch nicely."
  },
  {
    "id": "lin-10",
    "kind": "link",
    "needs": [
      "artist"
    ],
    "text": "A turn of pace with {artist}."
  },
  {
    "id": "lin-11",
    "kind": "link",
    "needs": [
      "artist",
      "title"
    ],
    "text": "{artist} on {title}, and it lands well."
  },
  {
    "id": "lin-12",
    "kind": "link",
    "needs": [
      "title"
    ],
    "text": "Play this one loud: {title}!"
  },
  {
    "id": "lin-13",
    "kind": "link",
    "needs": [
      "artist"
    ],
    "text": "{artist} again, and they earned the spot."
  },
  {
    "id": "lin-14",
    "kind": "link",
    "needs": [
      "artist",
      "title"
    ],
    "text": "From {title} to {artist}, we move."
  },
  {
    "id": "lin-15",
    "kind": "link",
    "needs": [
      "title"
    ],
    "text": "One more for the stretch, in the shape of {title}."
  },
  {
    "id": "lin-16",
    "kind": "link",
    "needs": [
      "prevTitle",
      "prevArtist",
      "title",
      "artist",
      "mood"
    ],
    "text": "We leave {prevTitle} by {prevArtist} for {title} by {artist}, and the {mood} mood carries straight across."
  },
  {
    "id": "lin-17",
    "kind": "link",
    "needs": [
      "prevTitle",
      "title",
      "tempoRelation"
    ],
    "text": "{prevTitle} eases out, {title} eases in, and the tempo is {tempoRelation}."
  },
  {
    "id": "lin-18",
    "kind": "link",
    "needs": [
      "prevTitle",
      "title",
      "keyRelation"
    ],
    "text": "In keys, {prevTitle} and {title} are {keyRelation}, which is exactly the plan."
  },
  {
    "id": "lin-19",
    "kind": "link",
    "needs": [
      "artist",
      "title",
      "mood"
    ],
    "text": "Up next, a {mood} one from {artist}: {title}!"
  },
  {
    "id": "lin-20",
    "kind": "link",
    "needs": [
      "prevArtist",
      "artist",
      "tempoRelation"
    ],
    "text": "{prevArtist} one, then {artist}, and the tempo stays {tempoRelation}."
  },
  {
    "id": "lin-21",
    "kind": "link",
    "needs": [
      "prevTitle",
      "title",
      "theme"
    ],
    "text": "From {prevTitle} into {title}: same {theme}, different road."
  },
  {
    "id": "lin-22",
    "kind": "link",
    "needs": [
      "title",
      "count",
      "timeOfDay"
    ],
    "text": "Set number {count}, the {timeOfDay} is holding, so here's {title}."
  },
  {
    "id": "lin-23",
    "kind": "link",
    "needs": [
      "artist",
      "title",
      "playCount"
    ],
    "text": "{artist} again, for the {playCount}th time, and {title} still earns its place."
  },
  {
    "id": "lin-24",
    "kind": "link",
    "needs": [
      "artist",
      "title",
      "lastPlayedDaysAgo"
    ],
    "text": "It's been a {lastPlayedDaysAgo}-day gap since {artist} brought us {title}."
  },
  {
    "id": "lin-25",
    "kind": "link",
    "needs": [
      "artist",
      "title",
      "firstTime"
    ],
    "text": "{artist} for {title}, {firstTime} for us, so let it breathe a little."
  },
  {
    "id": "lin-26",
    "kind": "link",
    "needs": [
      "prevTitle",
      "title",
      "mood",
      "keyRelation"
    ],
    "text": "After {prevTitle}, the {mood} of {title} keeps going, keys {keyRelation} all the way."
  },
  {
    "id": "lin-27",
    "kind": "link",
    "needs": [
      "prevTitle",
      "prevArtist",
      "title",
      "artist",
      "tempoRelation",
      "keyRelation"
    ],
    "text": "{prevTitle} by {prevArtist}, then {title} by {artist}: tempo {tempoRelation}, keys {keyRelation}."
  },
  {
    "id": "lin-28",
    "kind": "link",
    "needs": [
      "prevTitle",
      "title",
      "artist",
      "theme"
    ],
    "text": "{prevTitle} was about {theme}, and {title} keeps {artist} in that conversation."
  },
  {
    "id": "lin-29",
    "kind": "link",
    "needs": [
      "artist",
      "title",
      "mood",
      "timeOfDay"
    ],
    "text": "For {timeOfDay} listening, {artist} and {title} make a {mood} pair."
  },
  {
    "id": "lin-30",
    "kind": "link",
    "needs": [
      "title",
      "tempoRelation",
      "playCount"
    ],
    "text": "{title}, for the {playCount}th time, and the tempo is still {tempoRelation}."
  },
  {
    "id": "lin-31",
    "kind": "link",
    "needs": [
      "prevArtist",
      "prevTitle",
      "title"
    ],
    "text": "We leave {prevArtist} on {prevTitle} and pick up {title} from there."
  },
  {
    "id": "lin-32",
    "kind": "link",
    "needs": [
      "artist",
      "title",
      "keyRelation",
      "mood"
    ],
    "text": "{artist} next with {title}: a {mood} change, keys {keyRelation}."
  },
  {
    "id": "lin-33",
    "kind": "link",
    "needs": [
      "prevTitle",
      "title",
      "firstTime"
    ],
    "text": "{prevTitle} said its piece, and {title} says something new: {firstTime} for us."
  },
  {
    "id": "lin-34",
    "kind": "link",
    "needs": [
      "artist",
      "title",
      "lastPlayedDaysAgo",
      "theme"
    ],
    "text": "A {lastPlayedDaysAgo}-day gap, and {artist} is still the {theme} we reach for: {title}."
  },
  {
    "id": "lin-35",
    "kind": "link",
    "needs": [
      "prevArtist",
      "artist",
      "mood",
      "tempoRelation",
      "lastPlayedDaysAgo"
    ],
    "text": "{prevArtist} out, {artist} in, the mood turning {mood}, the tempo {tempoRelation}, and a {lastPlayedDaysAgo}-day gap behind it."
  },
  {
    "id": "lin-36",
    "kind": "link",
    "needs": [
      "title",
      "count"
    ],
    "text": "Number {count} in the set, and it's {title}."
  },
  {
    "id": "lin-37",
    "kind": "link",
    "needs": [
      "artist",
      "title",
      "playCount",
      "timeOfDay"
    ],
    "text": "For this {timeOfDay}, here's the {playCount}th time with {artist}, and {title} still fits."
  },
  {
    "id": "lin-38",
    "kind": "link",
    "needs": [
      "prevTitle",
      "prevArtist",
      "artist",
      "title",
      "mood"
    ],
    "text": "The hand-off from {prevTitle} to {title} is smooth, and both {prevArtist} and {artist} stay {mood}!"
  },
  {
    "id": "lin-39",
    "kind": "link",
    "needs": [
      "count",
      "title",
      "keyRelation"
    ],
    "text": "Set number {count} with {title}, and the keys are {keyRelation} to where we were."
  },
  {
    "id": "lin-40",
    "kind": "link",
    "needs": [
      "artist",
      "title",
      "theme"
    ],
    "text": "{artist} to {title}, which keeps the {theme} thread going."
  },
  {
    "id": "lin-41",
    "kind": "link",
    "needs": [
      "prevTitle",
      "title",
      "tempoRelation",
      "mood"
    ],
    "text": "From {prevTitle} to {title}, the {mood} holds and the tempo goes {tempoRelation}."
  },
  {
    "id": "lin-42",
    "kind": "link",
    "needs": [
      "title",
      "artist",
      "mood",
      "firstTime"
    ],
    "text": "{title} by {artist}, a {mood} turn, and {firstTime} for us to be honest!"
  },
  {
    "id": "cal-01",
    "kind": "callback",
    "needs": [
      "artist",
      "title"
    ],
    "text": "Here is {title} by {artist}."
  },
  {
    "id": "cal-02",
    "kind": "callback",
    "needs": [
      "artist",
      "title"
    ],
    "text": "Up next, {title} from {artist}."
  },
  {
    "id": "cal-03",
    "kind": "callback",
    "needs": [
      "artist",
      "title"
    ],
    "text": "{artist} brings us {title}."
  },
  {
    "id": "cal-04",
    "kind": "callback",
    "needs": [
      "artist",
      "title"
    ],
    "text": "A track from {artist} — {title}."
  },
  {
    "id": "cal-05",
    "kind": "callback",
    "needs": [
      "artist",
      "title"
    ],
    "text": "Let us hear {title} by {artist}."
  },
  {
    "id": "cal-06",
    "kind": "callback",
    "needs": [
      "artist",
      "title"
    ],
    "text": "{title}, the latest from {artist}."
  },
  {
    "id": "cal-07",
    "kind": "callback",
    "needs": [
      "artist",
      "title"
    ],
    "text": "From {artist}, this is {title}."
  },
  {
    "id": "cal-08",
    "kind": "callback",
    "needs": [
      "artist",
      "title"
    ],
    "text": "{artist} returns with {title}."
  },
  {
    "id": "cal-09",
    "kind": "callback",
    "needs": [
      "artist",
      "title"
    ],
    "text": "Presenting {title} by {artist}."
  },
  {
    "id": "cal-10",
    "kind": "callback",
    "needs": [
      "artist",
      "title"
    ],
    "text": "{artist} delivers {title}."
  },
  {
    "id": "cal-11",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "playCount"
    ],
    "text": "{artist} again, for the {playCount}th time with {title}."
  },
  {
    "id": "cal-12",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "lastPlayedDaysAgo"
    ],
    "text": "{title} by {artist}, last heard {lastPlayedDaysAgo} days ago."
  },
  {
    "id": "cal-13",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "firstTime"
    ],
    "text": "First time for {title} by {artist}."
  },
  {
    "id": "cal-14",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "playCount",
      "lastPlayedDaysAgo"
    ],
    "text": "{artist} with {title}, play number {playCount} after {lastPlayedDaysAgo} days."
  },
  {
    "id": "cal-15",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "firstTime",
      "playCount"
    ],
    "text": "A {firstTime} spin, play number {playCount} for {title} by {artist}."
  },
  {
    "id": "cal-16",
    "kind": "callback",
    "needs": [
      "prevArtist",
      "prevTitle",
      "artist",
      "title"
    ],
    "text": "After {prevTitle} by {prevArtist}, here is {title} from {artist}."
  },
  {
    "id": "cal-17",
    "kind": "callback",
    "needs": [
      "prevArtist",
      "prevTitle",
      "artist",
      "title",
      "tempoRelation"
    ],
    "text": "From {prevTitle} by {prevArtist} to {title} by {artist}, a {tempoRelation} pace."
  },
  {
    "id": "cal-18",
    "kind": "callback",
    "needs": [
      "prevArtist",
      "prevTitle",
      "artist",
      "title",
      "keyRelation"
    ],
    "text": "{prevTitle} by {prevArtist} flows into {title} by {artist}, keys {keyRelation}."
  },
  {
    "id": "cal-19",
    "kind": "callback",
    "needs": [
      "prevArtist",
      "prevTitle",
      "artist",
      "title",
      "tempoRelation",
      "keyRelation"
    ],
    "text": "Following {prevTitle} by {prevArtist}, {title} by {artist} matches tempo {tempoRelation} and key {keyRelation}."
  },
  {
    "id": "cal-20",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "mood"
    ],
    "text": "A {mood} one from {artist} — {title}."
  },
  {
    "id": "cal-21",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "mood",
      "timeOfDay"
    ],
    "text": "{mood} vibes for this {timeOfDay} with {title} by {artist}."
  },
  {
    "id": "cal-22",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "theme"
    ],
    "text": "Fitting the {theme} theme, {title} by {artist}."
  },
  {
    "id": "cal-23",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "theme",
      "mood"
    ],
    "text": "For the {theme} set, a {mood} pick: {title} from {artist}."
  },
  {
    "id": "cal-24",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "count"
    ],
    "text": "Track {count}: {title} by {artist}."
  },
  {
    "id": "cal-25",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "count",
      "theme"
    ],
    "text": "Number {count} in the {theme} run — {title} by {artist}."
  },
  {
    "id": "cal-26",
    "kind": "callback",
    "needs": [
      "prevArtist",
      "prevTitle",
      "artist",
      "title",
      "mood"
    ],
    "text": "After {prevTitle} by {prevArtist}, a {mood} shift to {title} by {artist}."
  },
  {
    "id": "cal-27",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "playCount",
      "mood"
    ],
    "text": "{playCount} plays in for {title} by {artist}, still {mood}."
  },
  {
    "id": "cal-28",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "lastPlayedDaysAgo",
      "mood"
    ],
    "text": "{lastPlayedDaysAgo} days since {title} by {artist}, still {mood}."
  },
  {
    "id": "cal-29",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "timeOfDay"
    ],
    "text": "Good {timeOfDay} with {title} from {artist}."
  },
  {
    "id": "cal-30",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "timeOfDay",
      "mood"
    ],
    "text": "This {timeOfDay} calls for {mood} — {title} by {artist}."
  },
  {
    "id": "cal-31",
    "kind": "callback",
    "needs": [
      "prevArtist",
      "prevTitle",
      "artist",
      "title",
      "timeOfDay"
    ],
    "text": "From {prevTitle} by {prevArtist} to {title} by {artist} as the {timeOfDay} rolls on."
  },
  {
    "id": "cal-32",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "firstTime",
      "timeOfDay"
    ],
    "text": "A {firstTime} this {timeOfDay}: {title} by {artist}."
  },
  {
    "id": "cal-33",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "playCount",
      "lastPlayedDaysAgo",
      "mood"
    ],
    "text": "{playCount} spins over {lastPlayedDaysAgo} days, {title} by {artist} stays {mood}."
  },
  {
    "id": "cal-34",
    "kind": "callback",
    "needs": [
      "prevArtist",
      "prevTitle",
      "artist",
      "title",
      "theme"
    ],
    "text": "The {theme} thread continues: {prevTitle} by {prevArtist}, then {title} by {artist}."
  },
  {
    "id": "cal-35",
    "kind": "callback",
    "needs": [
      "artist",
      "title",
      "count",
      "playCount"
    ],
    "text": "Entry {count}, play {playCount} for {title} by {artist}."
  }
];
