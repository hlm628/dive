import {
  computed, Ref, reactive, ref, onBeforeUnmount, toRef,
} from '@vue/composition-api';
import { uniq, flatMapDeep, flattenDeep } from 'lodash';
import Track, { TrackId } from 'vue-media-annotator/track';
import { RectBounds, updateBounds } from 'vue-media-annotator/utils';
import { EditAnnotationTypes, VisibleAnnotationTypes } from 'vue-media-annotator/layers';
import { MediaController } from 'vue-media-annotator/components/annotators/mediaControllerType';

import Recipe from 'vue-media-annotator/recipe';
import TrackStore from 'vue-media-annotator/TrackStore';
import type { AnnotationId } from 'vue-media-annotator/BaseAnnotation';
import type TrackFilterControls from 'vue-media-annotator/TrackFilterControls';
import BaseAnnotation from 'vue-media-annotator/BaseAnnotation';
import GroupStore from 'vue-media-annotator/GroupStore';

import { usePrompt } from 'dive-common/vue-utilities/prompt-service';
import { clientSettings } from 'dive-common/store/settings';
import GroupFilterControls from 'vue-media-annotator/GroupFilterControls';


type SupportedFeature = GeoJSON.Feature<GeoJSON.Point | GeoJSON.Polygon | GeoJSON.LineString>;

/* default to index + 1
 * call with -1 to select previous, or pass any other delta
 */
function selectNext<T extends BaseAnnotation>(
  filtered: Readonly<T>[], selected: Readonly<AnnotationId | null>, delta = 1,
): AnnotationId | null {
  if (filtered.length > 0) {
    if (selected === null) {
      // if no track is selected, return the first trackId
      return filtered[0].id;
    }
    // return the trackId by the delta offset if it exists
    const index = filtered.findIndex((t) => t.id === selected);
    const newIndex = index + delta;
    if (newIndex >= 0 && newIndex < filtered.length) {
      // if we are not at the end
      return filtered[newIndex].id;
    }
  }
  //Return null if no other conditions are met
  return null;
}

interface SetAnnotationStateArgs {
  visible?: VisibleAnnotationTypes[];
  editing?: EditAnnotationTypes;
  key?: string;
  recipeName?: string;
}
/**
 * The point of this composition function is to define and manage the transition betwee
 * different UI states within the program.  States and state transitions can be modified
 * based on settings, blocked if it tries to go to incompatible state or provide feedback
 *
 * Mostly allows us to inject additional logic into transitions.
 */
export default function useModeManager({
  trackStore,
  groupStore,
  trackFilterControls,
  groupFilterControls,
  mediaController,
  readonlyState,
  recipes,
}: {
    trackStore: TrackStore;
    groupStore: GroupStore;
    trackFilterControls: TrackFilterControls;
    groupFilterControls: GroupFilterControls;
  mediaController: Ref<MediaController>;
    readonlyState: Readonly<Ref<boolean>>;
    recipes: Recipe[];
}) {
  let creating = false;
  const { prompt } = usePrompt();
  const annotationModes = reactive({
    visible: ['rectangle', 'Polygon', 'LineString', 'text'] as VisibleAnnotationTypes[],
    editing: 'rectangle' as EditAnnotationTypes,
  });
  const trackSettings = toRef(clientSettings, 'trackSettings');
  const groupSettings = toRef(clientSettings, 'groupSettings');
  // Meaning of this value varies based on the editing mode.  When in
  // polygon edit mode, this corresponds to a polygon point.  Ditto in line mode.
  const selectedFeatureHandle = ref(-1);
  //The Key of the selected type, for now mostly ''
  const selectedKey = ref('');

  // the currently selected Track
  const selectedTrackId = ref(null as AnnotationId | null);

  // the currently editing Group
  const editingGroupId = ref(null as AnnotationId | null);

  // boolean whether or not selectedTrackId is also being edited.
  const editingTrack = ref(false);

  // which type is currently being edited, if any
  const editingMode = computed(() => editingTrack.value && annotationModes.editing);
  const editingCanary = ref(false);

  // Track Multi-select state
  const multiSelectList = ref([] as AnnotationId[]);
  const multiSelectActive = computed(() => multiSelectList.value.length > 0);

  const _filteredTracks = computed(
    () => trackFilterControls.filteredAnnotations.value.map((filtered) => filtered.annotation),
  );

  const _filteredGroups = computed(
    () => groupFilterControls.filteredAnnotations.value.map((filtered) => filtered.annotation),
  );

  const selectNextTrack = (delta = 1) => selectNext(
    _filteredTracks.value, selectedTrackId.value, delta,
  );

  const selectNextGroup = (delta = 1) => selectNext(
    _filteredGroups.value, editingGroupId.value, delta,
  );

  function selectTrack(trackId: AnnotationId | null, edit = false) {
    selectedTrackId.value = trackId;
    if (edit && readonlyState.value) {
      prompt({ title: 'Read Only Mode', text: 'This Dataset is in Read Only mode, no edits can be made.' });
    } else {
      editingTrack.value = trackId !== null && edit;
    }
  }

  /** end  */
  function _depend(): boolean {
    return editingCanary.value;
  }
  function _nudgeEditingCanary() {
    editingCanary.value = !editingCanary.value;
  }

  // What is occuring in editing mode
  const editingDetails = computed(() => {
    _depend();
    if (editingMode.value && selectedTrackId.value !== null) {
      const { frame } = mediaController.value;
      const track = trackStore.annotationMap.get(selectedTrackId.value);
      if (track) {
        const [feature] = track.getFeature(frame.value);
        if (feature) {
          if (!feature?.bounds?.length) {
            return 'Creating';
          } if (annotationModes.editing === 'rectangle') {
            return 'Editing';
          }
          return (feature.geometry?.features.filter((item) => item.geometry.type === annotationModes.editing).length ? 'Editing' : 'Creating');
        }
        return 'Creating';
      }
    }
    return 'disabled';
  });
  // which types are currently visible, always including the editingType
  const visibleModes = computed(() => (
    uniq(annotationModes.visible.concat(editingMode.value || []))
  ));

  /**
   * Figure out if a new feature should enable interpolation
   * based on current state and the result of canInterolate.
   */
  function _shouldInterpolate(canInterpolate: boolean) {
    // if this is a track, then whether to interpolate
    // is determined by newTrackSettings (if new track)
    // or canInterpolate (if existing track)
    const interpolateTrack = creating
      ? trackSettings.value.newTrackSettings.modeSettings.Track.interpolate
      : canInterpolate;
    // if detection, interpolate is always false
    return trackSettings.value.newTrackSettings.mode === 'Detection'
      ? false
      : interpolateTrack;
  }

  function seekNearest(track: Track) {
    // Seek to the nearest point in the track.
    const { frame } = mediaController.value;
    if (frame.value < track.begin) {
      mediaController.value.seek(track.begin);
    } else if (frame.value > track.end) {
      mediaController.value.seek(track.end);
    }
  }

  function _selectKey(key: string | undefined) {
    if (typeof key === 'string') {
      selectedKey.value = key;
    } else {
      selectedKey.value = '';
    }
  }

  function handleSelectFeatureHandle(i: number, key = '') {
    if (i !== selectedFeatureHandle.value) {
      selectedFeatureHandle.value = i;
    } else {
      selectedFeatureHandle.value = -1;
    }
    _selectKey(key);
  }

  function handleSelectTrack(trackId: TrackId | null, edit = false) {
    /**
     * If creating mode and editing and selectedTrackId is the same,
     * don't kick out of creating mode.  This happens when moving between
     * rect/poly/line during continuous creation.
     */
    if (!(creating && edit && trackId === selectedTrackId.value)) {
      creating = false;
    }
    /**
     * If merge is in progress, add selected tracks to the merge list
     */
    if (trackId !== null && multiSelectActive.value) {
      multiSelectList.value = Array.from((new Set(multiSelectList.value).add(trackId)));
      /**
       * If editing group, then the newly selected track should be added to the group
       */
      if (editingGroupId.value !== null && !edit) {
        const track = trackStore.get(trackId);
        groupStore.get(editingGroupId.value).addMembers({
          [trackId]: { ranges: [[track.begin, track.end]] },
        });
      } else if (edit) {
        editingGroupId.value = null;
        multiSelectList.value = [];
      }
    }
    /* Do not allow editing when merge is in progress */
    selectTrack(trackId, edit && !multiSelectActive.value);
  }

  /** Put UI into group editing mode. */
  function handleGroupEdit(groupId: AnnotationId | null) {
    creating = false;
    editingTrack.value = false;
    editingGroupId.value = groupId;
    if (groupId !== null) {
      /** When moving into a group edit mode, multi-select all track members */
      const group = groupStore.get(groupId);
      multiSelectList.value = group.memberIds;
      selectedTrackId.value = null;
      seekNearest(trackStore.get(multiSelectList.value[0]));
    }
  }

  //Handles deselection or hitting escape including while editing
  function handleEscapeMode() {
    if (selectedTrackId.value !== null) {
      const track = trackStore.annotationMap.get(selectedTrackId.value);
      if (track && track.begin === track.end) {
        const features = track.getFeature(track.begin);
        // If no features exist we remove the empty track
        if (!features.filter((item) => item !== null).length) {
          trackStore.remove(selectedTrackId.value);
        }
      }
    }
    multiSelectList.value = [];
    handleGroupEdit(null);
    handleSelectTrack(null, false);
  }

  function handleAddTrackOrDetection(): TrackId {
    // Handles adding a new track with the NewTrack Settings
    handleEscapeMode();
    const { frame } = mediaController.value;
    const newTrackId = trackStore.add(
      frame.value, trackSettings.value.newTrackSettings.type,
      selectedTrackId.value || undefined,
    ).trackId;
    selectTrack(newTrackId, true);
    creating = true;
    return newTrackId;
  }

  function newTrackSettingsAfterLogic(addedTrack: Track) {
    // Default settings which are updated by the TrackSettings component
    let newCreatingValue = false; // by default, disable creating at the end of this function
    if (creating) {
      if (addedTrack && trackSettings.value.newTrackSettings !== null) {
        if (trackSettings.value.newTrackSettings.mode === 'Track'
        && trackSettings.value.newTrackSettings.modeSettings.Track.autoAdvanceFrame
        ) {
          mediaController.value.nextFrame();
          newCreatingValue = true;
        } else if (trackSettings.value.newTrackSettings.mode === 'Detection') {
          if (
            trackSettings.value.newTrackSettings.modeSettings.Detection.continuous) {
            handleAddTrackOrDetection();
            newCreatingValue = true; // don't disable creating mode
          }
        }
      }
    }
    _nudgeEditingCanary();
    creating = newCreatingValue;
  }

  function handleUpdateRectBounds(frameNum: number, flickNum: number, bounds: RectBounds) {
    if (selectedTrackId.value !== null) {
      const track = trackStore.annotationMap.get(selectedTrackId.value);
      if (track) {
        // Determines if we are creating a new Detection
        const { interpolate } = track.canInterpolate(frameNum);

        track.setFeature({
          frame: frameNum,
          flick: flickNum,
          bounds,
          keyframe: true,
          interpolate: _shouldInterpolate(interpolate),
        });
        newTrackSettingsAfterLogic(track);
      }
    }
  }

  function handleUpdateGeoJSON(
    eventType: 'in-progress' | 'editing',
    frameNum: number,
    flickNum: number,
    // Type alias this
    data: SupportedFeature,
    key?: string,
    preventInterrupt?: () => void,
  ) {
    /**
     * Declare aggregate update collector. Each recipe
     * will have the opportunity to modify this object.
     */
    const update = {
      // Geometry data to be applied to the feature
      geoJsonFeatureRecord: {} as Record<string, SupportedFeature[]>,
      // Ploygons to be unioned with existing bounds (update)
      union: [] as GeoJSON.Polygon[],
      // Polygons to be unioned without existing bounds (overwrite)
      unionWithoutBounds: [] as GeoJSON.Polygon[],
      // If the editor mode should change types
      newType: undefined as EditAnnotationTypes | undefined,
      // If the selected key should change
      newSelectedKey: undefined as string | undefined,
      // If the recipe has completed
      done: [] as (boolean|undefined)[],
    };

    if (selectedTrackId.value !== null) {
      const track = trackStore.annotationMap.get(selectedTrackId.value);
      if (track) {
        // newDetectionMode is true if there's no keyframe on frameNum
        const { features, interpolate } = track.canInterpolate(frameNum);
        const [real] = features;

        // Give each recipe the opportunity to make changes
        recipes.forEach((recipe) => {
          const changes = recipe.update(eventType, frameNum, track, [data], key);
          // Prevent key conflicts among recipes
          Object.keys(changes.data).forEach((key_) => {
            if (key_ in update.geoJsonFeatureRecord) {
              throw new Error(`Recipe ${recipe.name} tried to overwrite key ${key_} when it was already set`);
            }
          });
          Object.assign(update.geoJsonFeatureRecord, changes.data);
          // Collect unions
          update.union.push(...changes.union);
          update.unionWithoutBounds.push(...changes.unionWithoutBounds);
          update.done.push(changes.done);
          // Prevent more than 1 recipe from changing a given mode/key
          if (changes.newType) {
            if (update.newType) {
              throw new Error(`Recipe ${recipe.name} tried to modify type when it was already set`);
            }
            update.newType = changes.newType;
          }
          if (changes.newSelectedKey) {
            if (update.newSelectedKey) {
              throw new Error(`Recipe ${recipe.name} tried to modify selectedKey when it was already set`);
            }
            update.newSelectedKey = changes.newSelectedKey;
          }
        });

        // somethingChanged indicates whether there will need to be a redraw
        // of the geometry currently displayed
        const somethingChanged = (
          update.union.length !== 0
          || update.unionWithoutBounds.length !== 0
          || Object.keys(update.geoJsonFeatureRecord).length !== 0
        );

        // If a drawable changed, but we aren't changing modes
        // prevent an interrupt within EditAnnotationLayer
        if (
          somethingChanged
          && !update.newSelectedKey
          && !update.newType
          && preventInterrupt
        ) {
          preventInterrupt();
        } else {
          // Otherwise, one of these state changes will trigger an interrupt.
          if (update.newSelectedKey) {
            selectedKey.value = update.newSelectedKey;
          }
          if (update.newType) {
            annotationModes.editing = update.newType;
            recipes.forEach((r) => r.deactivate());
          }
        }
        // Update the state of the track in the trackstore.
        if (somethingChanged) {
          track.setFeature({
            frame: frameNum,
            flick: flickNum,
            keyframe: true,
            bounds: updateBounds(real?.bounds, update.union, update.unionWithoutBounds),
            interpolate,
          }, flatMapDeep(update.geoJsonFeatureRecord,
            (geomlist, key_) => geomlist.map((geom) => ({
              type: geom.type,
              geometry: geom.geometry,
              properties: { key: key_ },
            }))));

          // Only perform "initialization" after the first shape.
          // Treat this as a completed annotation if eventType is editing
          // Or none of the recieps reported that they were unfinished.
          if (eventType === 'editing' || update.done.every((v) => v !== false)) {
            newTrackSettingsAfterLogic(track);
          }
        }
      } else {
        throw new Error(`${selectedTrackId.value} missing from trackMap`);
      }
    } else {
      throw new Error('Cannot call handleUpdateGeojson without a selected Track ID');
    }
  }

  /* If any recipes are active, allow them to remove a point */
  function handleRemovePoint() {
    if (selectedTrackId.value !== null && selectedFeatureHandle.value !== -1) {
      const track = trackStore.annotationMap.get(selectedTrackId.value);
      if (track) {
        recipes.forEach((r) => {
          if (r.active.value) {
            const { frame } = mediaController.value;
            r.deletePoint(
              frame.value,
              track,
              selectedFeatureHandle.value,
              selectedKey.value,
              annotationModes.editing,
            );
          }
        });
      }
    }
    handleSelectFeatureHandle(-1);
  }

  /* If any recipes are active, remove the geometry they added */
  function handleRemoveAnnotation() {
    if (selectedTrackId.value !== null) {
      const track = trackStore.annotationMap.get(selectedTrackId.value);
      if (track) {
        const { frame } = mediaController.value;
        recipes.forEach((r) => {
          if (r.active.value) {
            r.delete(frame.value, track, selectedKey.value, annotationModes.editing);
          }
        });
        _nudgeEditingCanary();
      }
    }
  }

  /**
   * Unstage a track from the merge list
   */
  function handleUnstageFromMerge(trackIds: TrackId[]) {
    multiSelectList.value = multiSelectList.value.filter((trackId) => !trackIds.includes(trackId));
    /* Unselect a track when it is unstaged */
    if (selectedTrackId.value !== null && trackIds.includes(selectedTrackId.value)) {
      handleSelectTrack(null);
    }
    /** Remove members from group if group editing */
    if (editingGroupId.value !== null) {
      const group = groupStore.annotationMap.get(editingGroupId.value);
      if (group) group.removeMembers(trackIds);
    }
    /** Exit group editing mode if last track is removed */
    if (multiSelectList.value.length === 0) {
      handleEscapeMode();
    }
  }

  async function handleRemoveTrack(trackIds: TrackId[], forcePromptDisable = false) {
    /* Figure out next track ID */
    const maybeNextTrackId = selectNextTrack(1);
    const previousOrNext = maybeNextTrackId !== null
      ? maybeNextTrackId
      : selectNextTrack(-1);
    /* Delete track */
    if (!forcePromptDisable && trackSettings.value.deletionSettings.promptUser) {
      const trackStrings = trackIds.map((track) => track.toString());
      const groups = flattenDeep(
        trackIds.map((trackId) => groupStore.lookupGroups(trackId)),
      );
      const text = (['Would you like to delete the following tracks:']).concat(trackStrings);
      if (groups.length > 0) {
        text.push('');
        text.push(`This track will be removed from ${groups.length} groups.`);
      }
      text.push('');
      text.push('This setting can be changed under the Track Settings');
      const result = await prompt({
        title: 'Delete Confirmation',
        text,
        positiveButton: 'OK',
        negativeButton: 'Cancel',
        confirm: true,
      });
      if (!result) {
        return;
      }
    }
    trackIds.forEach((trackId) => {
      trackStore.remove(trackId);
      groupStore.trackRemove(trackId);
    });
    handleUnstageFromMerge(trackIds);
    selectTrack(previousOrNext, false);
  }

  /** Toggle editing mode for track */
  function handleTrackEdit(trackId: TrackId) {
    const track = trackStore.get(trackId);
    seekNearest(track);
    const editing = trackId === selectedTrackId.value ? (!editingTrack.value) : true;
    handleSelectTrack(trackId, editing);
  }

  function handleTrackClick(trackId: TrackId) {
    const track = trackStore.get(trackId);
    seekNearest(track);
    handleSelectTrack(trackId, editingTrack.value);
  }

  function handleSelectNext(delta: number) {
    const newTrack = selectNextTrack(delta);
    /** Only allow selectNext when not in group editing mode. */
    if (newTrack !== null && editingGroupId.value === null) {
      handleSelectTrack(newTrack, false);
      seekNearest(trackStore.get(newTrack));
    }
  }

  function handleSetAnnotationState({
    visible, editing, key, recipeName,
  }: SetAnnotationStateArgs) {
    if (visible) {
      annotationModes.visible = visible;
    }
    if (editing) {
      annotationModes.editing = editing;
      _selectKey(key);
      handleSelectTrack(selectedTrackId.value, true);
      recipes.forEach((r) => {
        if (recipeName !== r.name) {
          r.deactivate();
        }
      });
    }
  }

  /**
   * Merge: Enabled whenever there are candidates in the merge list
   */
  function handleToggleMerge(): TrackId[] {
    if (!multiSelectActive.value && selectedTrackId.value !== null) {
      /* If no merge in progress and there is a selected track id */
      multiSelectList.value = [selectedTrackId.value];
      /* no editing in merge mode */
      selectTrack(selectedTrackId.value, false);
    } else {
      multiSelectList.value = [];
      handleGroupEdit(null);
    }
    return multiSelectList.value;
  }

  /**
   * Merge: Commit the multi-select list to merge
   */
  function handleCommitMerge() {
    if (multiSelectList.value.length >= 2) {
      const track = trackStore.get(multiSelectList.value[0]);
      const otherTrackIds = multiSelectList.value.slice(1);
      track.merge(otherTrackIds.map((trackId) => trackStore.get(trackId)));
      handleRemoveTrack(otherTrackIds, true);
      handleToggleMerge();
      handleSelectTrack(track.trackId, false);
    }
  }

  /**
   * Group: Add the currently selected track to a new group and
   * enter group editing mode.
   */
  function handleAddGroup() {
    if (selectedTrackId.value !== null) {
      const members = [trackStore.get(selectedTrackId.value)];
      const newGrp = groupStore.add(members, groupSettings.value.newGroupSettings.type);
      handleGroupEdit(newGrp.id);
    }
  }

  /**
   * Group: Remove group ids and unselect everything.
   */
  function handleRemoveGroup(ids: AnnotationId[]) {
    ids.forEach((groupId) => {
      groupStore.remove(groupId);
    });
    /* Figure out next track ID */
    const maybeNextGroupId = selectNextGroup(1);
    const previousOrNext = maybeNextGroupId !== null
      ? maybeNextGroupId
      : selectNextGroup(-1);
    handleEscapeMode();
    handleGroupEdit(previousOrNext);
  }

  /* Subscribe to recipe activation events */
  recipes.forEach((r) => r.bus.$on('activate', handleSetAnnotationState));
  /* Unsubscribe before unmount */
  onBeforeUnmount(() => {
    recipes.forEach((r) => r.bus.$off('activate', handleSetAnnotationState));
  });

  return {
    selectedTrackId,
    editingGroupId,
    editingMode,
    editingTrack,
    editingDetails,
    multiSelectList,
    multiSelectActive,
    visibleModes,
    selectedFeatureHandle,
    selectedKey,
    selectNextTrack,
    handler: {
      commitMerge: handleCommitMerge,
      groupAdd: handleAddGroup,
      groupEdit: handleGroupEdit,
      toggleMerge: handleToggleMerge,
      trackAdd: handleAddTrackOrDetection,
      trackAbort: handleEscapeMode,
      trackEdit: handleTrackEdit,
      trackSeek: handleTrackClick,
      trackSelect: handleSelectTrack,
      trackSelectNext: handleSelectNext,
      updateRectBounds: handleUpdateRectBounds,
      updateGeoJSON: handleUpdateGeoJSON,
      removeTrack: handleRemoveTrack,
      removePoint: handleRemovePoint,
      removeAnnotation: handleRemoveAnnotation,
      removeGroup: handleRemoveGroup,
      selectFeatureHandle: handleSelectFeatureHandle,
      setAnnotationState: handleSetAnnotationState,
      unstageFromMerge: handleUnstageFromMerge,
    },
  };
}
