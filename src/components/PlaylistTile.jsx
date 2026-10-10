import { memo } from 'react';
import { AsyncArtworkImage } from './AsyncArtworkImage.jsx';
import { TileFace } from './SongCard.jsx';

export const PlaylistTile = memo(function PlaylistTile({ playlist, songs, onOpen }) {
  const artSong = songs[0] || {
    songKey: playlist.playlistKey,
    track: playlist.name,
    artist: '',
  };
  const count = playlist.count ?? playlist.songKeys?.length ?? 0;
  const cover = songs.length >= 4 ? (
    <div className="playlist-tile__mosaic">
      {songs.slice(0, 4).map(song => (
        <AsyncArtworkImage
          key={song.songKey}
          defaultCover
          song={song}
          className="playlist-tile__mosaic-img"
          size={150}
          alt=""
        />
      ))}
    </div>
  ) : undefined;

  return (
    <button
      type="button"
      className="song-card song-card--group25 playlist-tile"
      onClick={onOpen}
      aria-label={`Open playlist ${playlist.name}`}
    >
      <div className="song-card__primary">
        <TileFace
          song={artSong}
          title={playlist.name}
          subtitle={`${count} songs`}
          statusText="Playlist"
          cover={cover}
        />
      </div>
    </button>
  );
});
