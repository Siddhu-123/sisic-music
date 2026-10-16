import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Compass, Music2, Search, Sparkles } from 'lucide-react';
import { AsyncArtworkImage } from './Components.jsx';
import {
  buildExploreMixes,
  filterExploreSongs,
  getExploreFacets,
  rankedExploreSearch,
} from '../services/exploreService.js';
import { buildDevilMix, buildLongMix, createInfiniteMix } from '../services/mixEngine.js';

function hueFromLabel(label = '') {
  return [...label].reduce((total, character) => total + character.charCodeAt(0), 0) % 360;
}

function SongRail({ title, subtitle, songs, renderSong }) {
  if (!songs.length) return null;
  return (
    <section className="explore-section">
      <div className="explore-section__heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </div>
      <div className="content-rail">
        {songs.map(song => renderSong(song, songs))}
      </div>
    </section>
  );
}

export function ExploreView({
  browseSongs = [],
  librarySongs = [],
  playbackEvents = [],
  gemmaVectors,
  likedSongKeys = [],
  catalogueLoading = false,
  renderSong,
  onRecommendationShown,
  onPlayMix,
}) {
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState('');
  const [mood, setMood] = useState('');
  const [availability, setAvailability] = useState('all');
  const [activeMixId, setActiveMixId] = useState('');

  const genres = useMemo(() => getExploreFacets(browseSongs, 'genre'), [browseSongs]);
  const moods = useMemo(() => getExploreFacets(browseSongs, 'mood'), [browseSongs]);
  const taste = useMemo(
    () => buildExploreMixes(librarySongs, { playbackEvents, likedSongKeys, ...(gemmaVectors?.size ? { gemmaVectors } : {}) }),
    [librarySongs, playbackEvents, likedSongKeys, gemmaVectors],
  );
  const activeMix = taste.mixes.find(mix => mix.id === activeMixId) || null;
  const rankedSongs = useMemo(() => rankedExploreSearch(query, browseSongs), [browseSongs, query]);
  const filteredSongs = useMemo(
    () => filterExploreSongs(rankedSongs, { genre, mood, availability }),
    [availability, genre, mood, rankedSongs],
  );
  const isFiltering = Boolean(query || genre || mood || availability !== 'all' || activeMix);
  const impression = activeMix
    ? { surface: 'explore-mix', keys: activeMix.songs.slice(0, 50).map(song => song.songKey), sourceId: activeMix.id }
    : !isFiltering ? { surface: 'explore-mixes', keys: taste.mixes.flatMap(mix => mix.songs).slice(0, 50).map(song => song.songKey), sourceId: '' } : null;
  const impressionSignature = impression ? `${impression.surface}|${impression.sourceId}|${impression.keys.join(',')}` : '';
  const lastImpressionRef = useRef('');
  useEffect(() => {
    // Log a list once when it is first shown or changes, not on every re-render.
    if (!impression || impressionSignature === lastImpressionRef.current) return;
    lastImpressionRef.current = impressionSignature;
    onRecommendationShown?.(impression.surface, impression.keys, impression.sourceId);
  }, [impressionSignature]); // eslint-disable-line react-hooks/exhaustive-deps
  const genreShelves = useMemo(
    () => genres.slice(0, 4).map(facet => ({
      ...facet,
      songs: filterExploreSongs(browseSongs, { genre: facet.label }).slice(0, 10),
    })).filter(shelf => shelf.songs.length),
    [browseSongs, genres],
  );

  const chooseMix = mix => {
    setActiveMixId(current => current === mix.id ? '' : mix.id);
    setQuery('');
    setGenre('');
    setMood('');
    setAvailability('all');
  };

  const playFlowMix = kind => {
    const context = { songs: librarySongs, gemmaVectors, events: playbackEvents };
    let songs = [];
    let sourceId = '';
    if (kind === 'long') {
      songs = buildLongMix(context, { minutes: 180 });
      sourceId = '3-hour-flow';
    } else if (kind === 'devil') {
      songs = buildDevilMix(context);
      sourceId = 'devil-mix';
    } else {
      const ranked = taste.mixes.find(mix => mix.id === 'your-taste')?.songs || [];
      const seed = ranked.find(song => gemmaVectors?.has(song.songKey) && gemmaVectors.get(song.songKey)?.vector)
        || librarySongs.find(song => gemmaVectors?.has(song.songKey) && gemmaVectors.get(song.songKey)?.vector);
      if (!seed) return;
      const radio = createInfiniteMix(context, { seedKey: seed.songKey });
      songs = [seed];
      while (songs.length < 50) {
        const next = radio.next();
        if (!next) break;
        songs.push(next);
      }
      sourceId = 'infinite-radio';
    }
    if (songs.length) onPlayMix?.(songs, { sourceType: 'mix', sourceId });
  };

  return (
    <div className="explore-view">
      <header className="explore-hero">
        <div>
          <span className="explore-hero__eyebrow"><Compass size={15} /> DISCOVER YOUR LIBRARY</span>
          <h1 className="main-view__title">Explore</h1>
          <p>Search, filter, and listen through collections built from your own music.</p>
        </div>
        <div className="search-box explore-search-box">
          <Search size={18} className="search-box__icon" />
          <input
            type="search"
            placeholder="Search songs, artists, albums, moods…"
            value={query}
            onChange={event => { setQuery(event.target.value); setActiveMixId(''); }}
            autoComplete="off"
            autoFocus
          />
        </div>
      </header>

      <section className="explore-filters" aria-label="Explore filters">
        <div className="explore-filter-row">
          <span>Genres</span>
          <button type="button" className={!genre ? 'explore-chip is-active' : 'explore-chip'} onClick={() => setGenre('')}>All</button>
          {genres.map(facet => (
            <button key={facet.label} type="button" className={genre === facet.label ? 'explore-chip is-active' : 'explore-chip'} onClick={() => { setGenre(current => current === facet.label ? '' : facet.label); setActiveMixId(''); }}>
              {facet.label}<small>{facet.count}</small>
            </button>
          ))}
        </div>
        <div className="explore-filter-row">
          <span>Moods</span>
          <button type="button" className={!mood ? 'explore-chip is-active' : 'explore-chip'} onClick={() => setMood('')}>All</button>
          {moods.map(facet => (
            <button key={facet.label} type="button" className={mood === facet.label ? 'explore-chip is-active' : 'explore-chip'} onClick={() => { setMood(current => current === facet.label ? '' : facet.label); setActiveMixId(''); }}>
              {facet.label}<small>{facet.count}</small>
            </button>
          ))}
        </div>
        <div className="explore-filter-row">
          <span>Library</span>
          {[
            ['all', 'All saved'],
            ['ready', 'Ready to play'],
          ].map(([value, label]) => (
            <button key={value} type="button" className={availability === value ? 'explore-chip is-active' : 'explore-chip'} onClick={() => { setAvailability(value); setActiveMixId(''); }}>{label}</button>
          ))}
        </div>
      </section>

      {gemmaVectors?.size > 0 && (
        <section className="explore-section" aria-label="Flow mixes">
          <div className="explore-section__heading"><div><h2>Flow mixes</h2></div></div>
          <div className="explore-filter-row">
            <button type="button" className="explore-chip" onClick={() => playFlowMix('long')}>3-hour flow</button>
            <button type="button" className="explore-chip" onClick={() => playFlowMix('devil')}>Devil mix</button>
            <button type="button" className="explore-chip" onClick={() => playFlowMix('infinite')}>Infinite radio</button>
          </div>
        </section>
      )}

      {catalogueLoading && !browseSongs.length ? (
        <div className="empty-state" role="status"><Search size={48} color="var(--text-muted)" /><h3>Preparing Explore</h3><p>Loading your searchable music catalogue…</p></div>
      ) : !browseSongs.length ? (
        <div className="empty-state"><Music2 size={48} color="var(--text-muted)" /><h3>No music to explore yet</h3><p>Sync or import songs to start building personal mixes.</p></div>
      ) : isFiltering ? (
        <section className="explore-section">
          <div className="explore-section__heading">
            <div>
              <h2>{activeMix?.title || 'Explore results'}</h2>
              <p>{activeMix?.subtitle || `${filteredSongs.length} matching songs`}</p>
            </div>
            {activeMix && <button className="explore-clear" type="button" onClick={() => setActiveMixId('')}>Clear mix</button>}
          </div>
          {activeMix ? (
            <div className="content-rail">{activeMix.songs.map(song => renderSong(song, activeMix.songs, { sourceType: 'mix', sourceId: activeMix.id }))}</div>
          ) : filteredSongs.length ? (
            <div className="songs-grid explore-results-grid">{filteredSongs.slice(0, 48).map(song => renderSong(song, query.trim() ? null : filteredSongs, { isSearch: Boolean(query.trim()), searchText: query }))}</div>
          ) : (
            <div className="empty-state explore-empty"><Music2 size={40} color="var(--text-muted)" /><h3>No matches</h3><p>Try clearing a mood, genre, or library filter.</p></div>
          )}
        </section>
      ) : (
        <>
          <section className="explore-section">
            <div className="explore-section__heading">
              <div>
                <h2>Made from your library</h2>
                <p>{taste.hasTasteSignal ? 'Your private listening pattern powers these mixes.' : 'These mixes will learn as you play and like music.'}</p>
              </div>
              <Sparkles size={20} aria-hidden="true" />
            </div>
            <div className="explore-mix-grid">
              {taste.mixes.map(mix => {
                const hero = mix.songs[0];
                const hue = hueFromLabel(mix.title);
                return (
                  <button key={mix.id} type="button" className="explore-mix-card" onClick={() => chooseMix(mix)}>
                    <div className="explore-mix-card__art" style={{ '--mix-hue': hue }}>
                      {hero && <AsyncArtworkImage song={hero} className="explore-mix-card__image" fallbackSize={22} size={180} />}
                    </div>
                    <span>Smart mix · Explore only</span>
                    <strong>{mix.title}</strong>
                    <small>{mix.songs.length} songs · {mix.subtitle}</small>
                  </button>
                );
              })}
            </div>
          </section>

          <SongRail title="Suggested for you" subtitle="A gentle next set from your own library" songs={taste.suggestions.slice(0, 10)} renderSong={(song, list) => renderSong(song, list, { sourceType: 'mix', sourceId: 'suggested-for-you' })} />
          {genreShelves.map(shelf => <SongRail key={shelf.label} title={shelf.label} subtitle={`${shelf.count} songs in your catalogue`} songs={shelf.songs} renderSong={renderSong} />)}
        </>
      )}
    </div>
  );
}
