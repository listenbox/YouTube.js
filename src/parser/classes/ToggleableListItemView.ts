import { YTNode } from '../helpers.js';
import { Parser, type RawNode } from '../index.js';
import ListItemView from './ListItemView.js';

export default class ToggleableListItemView extends YTNode {
  static type = 'ToggleableListItemView';

  public default_list_item: ListItemView | null;
  public toggled_list_item: ListItemView | null;
  public is_toggled: boolean;
  public entity_key: string;
  public entity_selector_type: string;

  constructor(data: RawNode) {
    super();
    this.default_list_item = Parser.parseItem(data.defaultListItem, ListItemView);
    this.toggled_list_item = Parser.parseItem(data.toggledListItem, ListItemView);
    this.is_toggled = !!data.initialState?.isToggled;
    this.entity_key = data.entityKey;
    this.entity_selector_type = data.entitySelectorType;
  }
}
