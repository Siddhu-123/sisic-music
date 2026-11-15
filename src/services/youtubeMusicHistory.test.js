import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertYoutubeMusicToPlaybackEvents,
  extractYoutubeMusicLikes,
  parseTakeoutTimestampMs,
  parseTakeoutWatchHistoryHtml,
} from './youtubeMusicHistory.js';

const LIBRARY = [
  {
    songKey: 'anirudh ravichander::naa ready',
    track: 'Naa Ready',
    artist: 'Anirudh Ravichander',
    sourceVideoId: 'vid-naaready',
    sourceDuration: 248,
  },
  {
    songKey: 'd imman sid sriram::kannana kanne from viswasam',
    track: 'Kannana Kanne (From "Viswasam")',
    artist: 'D. Imman, Sid Sriram',
    sourceVideoId: 'vid-kannana',
    sourceDuration: 268,
  },
];

const SAMPLE_HTML = `
<div class="outer-cell mdl-cell"><div class="mdl-grid">
  <div class="header-cell"><p class="mdl-typography--title">YouTube<br></p></div>
  <div class="content-cell mdl-typography--body-1">Watched&nbsp;<a href="https://www.youtube.com/watch?v=yt-vid-1">Blender Tutorial</a><br><a href="https://www.youtube.com/channel/UC1">Kyle</a><br>Nov 15, 2026, 2:45:00\u202fAM ACDT<br></div>
</div></div>
<div class="outer-cell mdl-cell"><div class="mdl-grid">
  <div class="header-cell"><p class="mdl-typography--title">YouTube Music<br></p></div>
  <div class="content-cell mdl-typography--body-1">Watched&nbsp;<a href="https://music.youtube.com/watch?v=unmatched-1">Other Song</a><br><a href="https://www.youtube.com/channel/UC2">Someone - Topic</a><br>Nov 15, 2026, 2:40:25\u202fAM ACDT<br></div>
</div></div>
<div class="outer-cell mdl-cell"><div class="mdl-grid">
  <div class="header-cell"><p class="mdl-typography--title">YouTube Music<br></p></div>
  <div class="content-cell mdl-typography--body-1">Watched&nbsp;<a href="https://music.youtube.com/watch?v=alt-vid">Kannana Kanne</a><br><a href="https://www.youtube.com/channel/UC3">Sid Sriram - Topic</a><br>Nov 15, 2026, 2:40:00\u202fAM ACDT<br></div>
</div></div>
<div class="outer-cell mdl-cell"><div class="mdl-grid">
  <div class="header-cell"><p class="mdl-typography--title">YouTube Music<br></p></div>
  <div class="content-cell mdl-typography--body-1">Watched&nbsp;<a href="https://music.youtube.com/watch?v=vid-naaready">Naa Ready &amp; Beat</a><br><a href="https://www.youtube.com/channel/UC4">Sony Music South</a><br>Nov 15, 2026, 2:35:00\u202fAM ACDT<br></div>
</div></div>
`;

describe('youtubeMusicHistory', () => {
  it('separates YouTube Music records from YouTube videos and parses ACDT timestamps', () => {
    const parsed = parseTakeoutWatchHistoryHtml(SAMPLE_HTML);
    assert.equal(parsed.totalBlocks, 4);
    assert.equal(parsed.youtubeVideoCount, 1);
    assert.equal(parsed.youtubeMusicRecords.length, 3);
    assert.equal(parsed.youtubeMusicRecords[1].artist, 'Sid Sriram');
    assert.equal(parsed.youtubeMusicRecords[2].videoId, 'vid-naaready');
    assert.equal(parsed.youtubeMusicRecords[2].title, 'Naa Ready & Beat');
    assert.equal(
      parseTakeoutTimestampMs('Nov 15, 2026, 2:35:00\u202fAM ACDT'),
      Date.parse('2026-11-15T02:35:00+10:30'),
    );
  });

  it('infers completes and skips from raw chronological gaps even before unmatched tracks', () => {
    const { youtubeMusicRecords } = parseTakeoutWatchHistoryHtml(SAMPLE_HTML);
    const { events, stats } = convertYoutubeMusicToPlaybackEvents(youtubeMusicRecords, LIBRARY);

    assert.equal(stats.ytmStreams, 3);
    assert.equal(stats.matchedStreams, 2);
    assert.equal(stats.videoIdMatches, 1);
    assert.equal(stats.artistTokenMatches, 1);
    assert.equal(stats.completes, 1);
    assert.equal(stats.skips, 1);

    assert.deepEqual(
      events.map(e => `${e.songKey}:${e.eventType}`),
      [
        'anirudh ravichander::naa ready:playback-start',
        'anirudh ravichander::naa ready:playback-complete',
        'd imman sid sriram::kannana kanne from viswasam:playback-start',
        'd imman sid sriram::kannana kanne from viswasam:user-skip',
      ],
    );
    assert.equal(events[3].positionSeconds, 25);
  });

  it('isolates music library songs and music playlists from non-music playlists', () => {
    const musicLibraryCsv = [
      'Video ID,Song Title,Album Title,Artist Name 1,Artist Name 2',
      'vid-kannana,Kannana Kanne,Viswasam,D. Imman,Sid Sriram',
    ].join('\n');
    const playlistsCsv = [
      'Playlist ID,Playlist Title (Original),Playlist Description (Original)',
      'PL1,blender,""',
      'PL2,Favorite Songs,"transferred by tunemymusic.com"',
    ].join('\n');
    const playlistVideoCsvs = {
      'blender-videos.csv': 'Video ID,Timestamp\nvid-naaready,2026-01-01T00:00:00Z\n',
      'Favorite Songs-videos.csv': 'Video ID,Timestamp\nvid-naaready,2026-01-01T00:00:00Z\n',
    };

    const likes = extractYoutubeMusicLikes({
      librarySongs: LIBRARY,
      musicLibraryCsv,
      playlistsCsv,
      playlistVideoCsvs,
    });

    assert.deepEqual(likes.musicPlaylists, [
      { title: 'Favorite Songs', tracks: 1, matchedLibraryTracks: 1 },
    ]);
    assert.deepEqual(likes.likedSongKeys.sort(), [
      'anirudh ravichander::naa ready',
      'd imman sid sriram::kannana kanne from viswasam',
    ]);
  });
});
