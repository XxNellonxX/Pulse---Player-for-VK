/** Open catalog metadata. These entities do not contain playable audio. */
export type CatalogArtistSummary = {
  id: string;
  name: string;
  sortName: string;
  disambiguation: string;
  kind?: string;
  country?: string;
};

export type CatalogArtistDetails = CatalogArtistSummary & {
  description?: string;
  links: Array<{ label: string; url: string }>;
  tags: string[];
};

export type CatalogRelease = {
  id: string;
  title: string;
  firstReleaseDate?: string;
  primaryType?: string;
  secondaryTypes: string[];
};

export type CatalogArtistSearch = {
  artists: CatalogArtistSummary[];
  hasMore: boolean;
  offset: number;
  stale: boolean;
  fetchedAt: number;
};

export type CatalogArtistPage = {
  artist: CatalogArtistDetails;
  releases: CatalogRelease[];
  hasMore: boolean;
  offset: number;
  stale: boolean;
  fetchedAt: number;
};
