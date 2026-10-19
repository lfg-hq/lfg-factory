/** Stored in the existing page_previews JSON column; old preview records remain valid. */
export interface ChatArtifact {
  id: string;
  name: string;
  kind?: 'document' | 'tickets';
  fileType?: string;
  /** Saved version holding the content before this turn's edit; enables Review changes. */
  previousVersion?: number;
  tickets?: Array<{ id: string; name: string; ticketKey?: string | null }>;
}
