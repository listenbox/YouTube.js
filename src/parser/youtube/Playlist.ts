import { InnertubeError } from '../../utils/Utils.js';

import Feed from '../../core/mixins/Feed.js';
import Alert from '../classes/Alert.js';
import AvatarStackView from '../classes/AvatarStackView.js';
import ContinuationItem from '../classes/ContinuationItem.js';
import ContinuationItemView from '../classes/ContinuationItemView.js';
import ItemSection from '../classes/ItemSection.js';
import Message from '../classes/Message.js';
import PlaylistCustomThumbnail from '../classes/PlaylistCustomThumbnail.js';
import PlaylistHeader from '../classes/PlaylistHeader.js';
import PlaylistMetadata from '../classes/PlaylistMetadata.js';
import PlaylistSidebarPrimaryInfo from '../classes/PlaylistSidebarPrimaryInfo.js';
import PlaylistSidebarSecondaryInfo from '../classes/PlaylistSidebarSecondaryInfo.js';
import PlaylistVideo from '../classes/PlaylistVideo.js';
import PlaylistVideoList from '../classes/PlaylistVideoList.js';
import PlaylistVideoThumbnail from '../classes/PlaylistVideoThumbnail.js';
import SectionList from '../classes/SectionList.js';
import TwoColumnBrowseResults from '../classes/TwoColumnBrowseResults.js';
import VideoOwner from '../classes/VideoOwner.js';
import AppendContinuationItemsAction from '../classes/actions/AppendContinuationItemsAction.js';
import ShowEngagementPanelEndpoint from '../classes/endpoints/ShowEngagementPanelEndpoint.js';
import { ReloadContinuationItemsCommand } from '../continuations.js';
import { observe, type ObservedArray, type YTNode } from '../helpers.js';

import type { Actions, ApiResponse } from '../../core/index.js';
import type NavigationEndpoint from '../classes/NavigationEndpoint.js';
import type Thumbnail from '../classes/misc/Thumbnail.js';
import type { IBrowseResponse, IShowEngagementPanelResponse } from '../types/index.js';

export default class Playlist extends Feed<IBrowseResponse> {
  public info;
  public menu: YTNode;
  public endpoint?: NavigationEndpoint;
  public messages: ObservedArray<Message>;

  readonly #items: YTNode[] = [];
  readonly #continuations: (ContinuationItem | ContinuationItemView)[] = [];
  #is_complete = true;

  constructor(actions: Actions, data: ApiResponse | IBrowseResponse, already_parsed = false) {
    super(actions, data, already_parsed);

    const header = this.memo.getType(PlaylistHeader)[0];
    const primary_info = this.memo.getType(PlaylistSidebarPrimaryInfo)[0];
    const secondary_info = this.memo.getType(PlaylistSidebarSecondaryInfo)[0];
    const video_list = this.memo.getType(PlaylistVideoList)[0];
    const alert = this.page.alerts?.firstOfType(Alert);

    if (alert && alert.alert_type === 'ERROR')
      throw new InnertubeError(alert.text.toString(), alert);

    if (!primary_info && !secondary_info && Object.keys(this.page).length === 0)
      throw new InnertubeError('Got empty continuation response. This is likely the end of the playlist.');

    this.info = {
      ...this.page.metadata?.item().as(PlaylistMetadata),
      ...{
        subtitle: header ? header.subtitle : null,
        author: secondary_info?.owner?.as(VideoOwner).author ?? header?.author,
        thumbnails: primary_info?.thumbnail_renderer?.as(PlaylistVideoThumbnail, PlaylistCustomThumbnail).thumbnail as Thumbnail[],
        total_items: this.#getStat(0, primary_info),
        views: this.#getStat(1, primary_info),
        last_updated: this.#getStat(2, primary_info),
        can_share: header?.can_share,
        can_delete: header?.can_delete,
        can_reorder: video_list?.can_reorder,
        is_editable: video_list?.is_editable,
        privacy: header?.privacy
      }
    };

    this.menu = primary_info?.menu;
    this.endpoint = primary_info?.endpoint;
    this.messages = this.memo.getType(Message);
    this.#readPlaylistContents();
  }

  async getCollaborators(): Promise<IShowEngagementPanelResponse> {
    if (!this.actions.session.logged_in)
      throw new Error('You must be signed in to perform this operation.');

    const avatar_stack_view = this.memo.getType(AvatarStackView)?.find((item) => item.renderer_context.command_context);
    const endpoint = avatar_stack_view?.renderer_context.command_context?.on_tap;

    if (!endpoint)
      throw new InnertubeError('AvatarStackView on_tap endpoint not found');

    if (endpoint.command?.is(ShowEngagementPanelEndpoint)) {
      return await endpoint.call(this.actions, { parse: true });
    }

    throw new InnertubeError(`Unexpected endpoint type. Expected ShowEngagementPanelEndpoint, got ${endpoint.command?.type}`);
  }

  /** Listing entries in source order, including unsupported nodes. */
  get items(): ObservedArray<YTNode> {
    return observe([ ...this.#items ], this.#is_complete);
  }

  /** Whether listing containers and availability alerts retained every node. */
  get is_complete(): boolean {
    return this.#is_complete;
  }

  get has_continuation() {
    return this.#continuations.length > 0;
  }

  async getContinuationData(): Promise<IBrowseResponse | undefined> {
    if (!this.#is_complete)
      throw new InnertubeError('Playlist listing is incomplete.');
    const continuation = this.#continuations[0];
    if (!continuation)
      throw new InnertubeError('There are no continuations.');
    return await continuation.endpoint.call<IBrowseResponse>(this.actions, { parse: true });
  }

  async getContinuation(): Promise<Playlist> {
    const page = await this.getContinuationData();
    if (!page)
      throw new InnertubeError('Could not get continuation data');
    return new Playlist(this.actions, page, true);
  }

  #readPlaylistContents(): void {
    this.#is_complete &&= this.page.alerts?.is_complete ?? true;
    const updates = [
      ...this.page.on_response_received_actions || [],
      ...this.page.on_response_received_endpoints || []
    ].filter((node) => node.is(AppendContinuationItemsAction, ReloadContinuationItemsCommand));
    const root = this.page.contents?.is_node ? this.page.contents.item() : null;
    if (updates.length) {
      // Continuation responses can also contain tab chrome without a body.
      if (updates.length === 1) {
        this.#readListing(updates[0].contents);
      } else {
        this.#is_complete = false;
      }
    } else if (root?.is(TwoColumnBrowseResults)) {
      this.#is_complete &&= root.tabs.is_complete;
      const tabs = root.tabs.filter((tab) => tab.content);
      if (tabs.length === 1) {
        this.#readListing(observe([ tabs[0].content! ]));
      } else {
        this.#is_complete = false;
      }
    } else if (root) {
      this.#readListing(observe([ root ]));
    } else {
      // A missing listing cannot establish an empty playlist.
      this.#is_complete = false;
    }
    this.#is_complete &&= this.#continuations.length <= 1;
  }

  #readListing(contents: ObservedArray<YTNode> | null, section_list = false): void {
    if (!contents) {
      this.#is_complete = false;
      return;
    }
    this.#is_complete &&= contents.is_complete;
    for (const node of contents) {
      if (node.is(SectionList)) {
        this.#readListing(node.contents, true);
        // Token-only pagination is not represented by a listing endpoint.
        this.#is_complete &&= !node.continuation;
      } else if (node.is(ItemSection)) {
        this.#readListing(node.contents);
        this.#is_complete &&= !node.continuation;
      } else if (node.is(PlaylistVideoList)) {
        this.#readListing(node.videos);
      } else if (node.is(ContinuationItem, ContinuationItemView)) {
        // Direct SectionList continuations fetch recommendations, not members.
        if (!section_list)
          this.#continuations.push(node);
      } else if (!node.is(PlaylistVideo) || node.style !== 'PLAYLIST_VIDEO_RENDERER_STYLE_RECOMMENDED_VIDEO') {
        this.#items.push(node);
      }
    }
  }

  #getStat(index: number, primary_info?: PlaylistSidebarPrimaryInfo): string {
    if (!primary_info || !primary_info.stats) return 'N/A';
    return primary_info.stats[index]?.toString() || 'N/A';
  }
}
