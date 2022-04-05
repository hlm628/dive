import {
  computed, Ref, reactive, ref, onBeforeUnmount, toRef,
} from '@vue/composition-api';
import { uniq, flatMapDeep } from 'lodash';
import Track, { TrackId } from 'vue-media-annotator/track';
import {
  getAnyTrack, getPossibleTrack, getTrack, getTrackAll, getTracksMerged,
} from 'vue-media-annotator/use/useTrackStore';
import { RectBounds, updateBounds } from 'vue-media-annotator/utils';
import { EditAnnotationTypes, VisibleAnnotationTypes } from 'vue-media-annotator/layers';
import { AggregateMediaController } from 'vue-media-annotator/components/annotators/mediaControllerType';

import Recipe from 'vue-media-annotator/recipe';
import { usePrompt } from 'dive-common/vue-utilities/prompt-service';
import { clientSettings } from 'dive-common/store/settings';

type SupportedFeature = GeoJSON.Feature<GeoJSON.Point | GeoJSON.Polygon | GeoJSON.LineString>;

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
  selectedTrackId,
  selectedCamera,
  editingTrack,
  camMap,
  aggregateController,
  recipes,
  selectTrack,
  selectNextTrack,
  addTrack,
  removeTrack,
}: {
  selectedTrackId: Ref<TrackId | null>;
  selectedCamera: Ref<string>;
  editingTrack: Ref<boolean>;
  camMap: Map<string, Map<TrackId, Track>>;
  aggregateController: Ref<AggregateMediaController>;
  recipes: Recipe[];
  selectTrack: (trackId: TrackId | null, edit: boolean) => void;
  selectNextTrack: (delta?: number) => TrackId | null;
  addTrack: (frame: number, defaultType: string, afterId?: TrackId,
    cameraName?: string, overrideTrackId?: number) => Track;
  removeTrack: (trackId: TrackId, disableNotifications?: boolean, cameraName?: string) => void;
}) {
  let creating = false;

  const annotationModes = reactive({
    visible: ['rectangle', 'Polygon', 'LineString', 'text'] as VisibleAnnotationTypes[],
    editing: 'rectangle' as EditAnnotationTypes,
  });
  const trackSettings = toRef(clientSettings, 'trackSettings');

  // selectedFeatureHandle could arguably belong in useTrackSelectionControls,
  // but the meaning of this value varies based on the editing mode.  When in
  // polygon edit mode, this corresponds to a polygon point.  Ditto in line mode.
  const selectedFeatureHandle = ref(-1);
  //The Key of the selected type, for now mostly ''
  const selectedKey = ref('');
  // which type is currently being edited, if any
  const editingMode = computed(() => editingTrack.value && annotationModes.editing);
  const editingCanary = ref(false);
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
      const { frame } = aggregateController.value;
      try {
        const track = getPossibleTrack(camMap, selectedTrackId.value, selectedCamera.value);
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
      } catch {
        // No track for this camera
        return 'disabled';
      }
    }
    return 'disabled';
  });
  // which types are currently visible, always including the editingType
  const visibleModes = computed(() => (
    uniq(annotationModes.visible.concat(editingMode.value || []))
  ));
  // Track merge state
  const mergeList = ref([] as TrackId[]);
  const mergeInProgress = computed(() => mergeList.value.length > 0);

  const linkingState = ref(false);
  const linkingTrack: Ref<TrackId| null> = ref(null);
  const linkingCamera = ref('');

  const { prompt } = usePrompt();
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
    const { frame } = aggregateController.value;
    if (frame.value < track.begin) {
      aggregateController.value.seek(track.begin);
    } else if (frame.value > track.end) {
      aggregateController.value.seek(track.end);
    }
  }

  async function _setLinkingTrack(trackId: TrackId) {
    //Confirm that there is no track for other cameras.
    const trackList = getTrackAll(camMap, trackId);
    if (trackList.length > 1) {
      prompt({
        title: 'Linking Error',
        text: [`TrackId: ${trackId} has tracks on other cameras besides the selected camera ${linkingCamera.value}`,
          `You need to select a track that only exists on camera: ${linkingCamera.value} `,
          'You can split of the track you were trying to select by clicking OK and hitting Escape to exit Linking Mode and using the split tool',
        ],
        positiveButton: 'OK',
      });
    } else {
      linkingTrack.value = trackId;
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
    if (trackId !== null && mergeInProgress.value) {
      mergeList.value = Array.from((new Set(mergeList.value).add(trackId)));
    } else if (linkingState.value) {
      // Only use the first non-null track with is clicked on to link
      if (trackId !== null) {
        _setLinkingTrack(trackId);
      }
      return;
    }
    /* Do not allow editing when merge is in progres or linking */
    selectTrack(trackId, edit && !mergeInProgress.value);
  }

  //Handles deselection or hitting escape including while editing
  function handleEscapeMode() {
    if (selectedTrackId.value !== null) {
      const track = getPossibleTrack(camMap, selectedTrackId.value, selectedCamera.value);
      if (track && track.begin === track.end) {
        const features = track.getFeature(track.begin);
        // If no features exist we remove the empty track on the current camera
        if (!features.filter((item) => item !== null).length) {
          removeTrack(selectedTrackId.value, true, selectedCamera.value);
        }
      }
    }
    linkingState.value = false;
    linkingCamera.value = '';
    linkingTrack.value = null;
    mergeList.value = [];
    handleSelectTrack(null, false);
  }

  function handleAddTrackOrDetection(overrideTrackId?: number): TrackId {
    // Handles adding a new track with the NewTrack Settings
    const { frame } = aggregateController.value;
    let trackType = trackSettings.value.newTrackSettings.type;
    if (overrideTrackId !== undefined) {
      const track = getAnyTrack(camMap, overrideTrackId);
      // eslint-disable-next-line prefer-destructuring
      trackType = track.confidencePairs[0][0];
    }
    const newTrackId = addTrack(
      frame.value, trackType,
      selectedTrackId.value || undefined, selectedCamera.value, overrideTrackId ?? undefined,
    ).trackId;
    selectTrack(newTrackId, true);
    creating = true;
    return newTrackId;
  }

  function handleTrackTypeChange(trackId: TrackId | null, value: string) {
    // Change of type will change all tracks types
    if (trackId !== null) {
      getTrackAll(camMap, trackId).forEach((track) => track.setType(value));
    }
  }

  function newTrackSettingsAfterLogic(addedTrack: Track) {
    // Default settings which are updated by the TrackSettings component
    let newCreatingValue = false; // by default, disable creating at the end of this function
    if (creating) {
      if (addedTrack && trackSettings.value.newTrackSettings !== null) {
        if (trackSettings.value.newTrackSettings.mode === 'Track'
        && trackSettings.value.newTrackSettings.modeSettings.Track.autoAdvanceFrame
        ) {
          aggregateController.value.nextFrame();
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
      const track = getPossibleTrack(camMap, selectedTrackId.value, selectedCamera.value);
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
      const track = getPossibleTrack(camMap, selectedTrackId.value, selectedCamera.value);
      if (track) {
        // newDetectionMode is true if there's no keyframe on frameNum
        const { features, interpolate } = track.canInterpolate(frameNum);
        const [real] = features;

        // Give each recipe the opportunity to make changes
        recipes.forEach((recipe) => {
          if (!track) {
            return;
          }
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
      const track = getPossibleTrack(camMap, selectedTrackId.value, selectedCamera.value);
      if (track !== undefined) {
        recipes.forEach((r) => {
          if (r.active.value && track) {
            const { frame } = aggregateController.value;
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
      const track = getPossibleTrack(camMap, selectedTrackId.value, selectedCamera.value);
      if (track !== undefined) {
        const { frame } = aggregateController.value;
        recipes.forEach((r) => {
          if (r.active.value && track) {
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
    mergeList.value = mergeList.value.filter((trackId) => !trackIds.includes(trackId));
  }

  async function handleRemoveTrack(trackIds: TrackId[], forcePromptDisable = false, cameraName = '') {
    /* Figure out next track ID */
    const maybeNextTrackId = selectNextTrack(1);
    const previousOrNext = maybeNextTrackId !== null
      ? maybeNextTrackId
      : selectNextTrack(-1);
    /* Delete track */
    if (!forcePromptDisable && trackSettings.value.deletionSettings.promptUser) {
      const trackStrings = trackIds.map((track) => track.toString());
      const text = (['Would you like to delete the following tracks:']).concat(trackStrings);
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
      removeTrack(trackId, false, cameraName);
    });
    handleUnstageFromMerge(trackIds);
    if (cameraName === '') {
      selectTrack(previousOrNext, false);
    }
  }

  /** Toggle editing mode for track */
  function handleTrackEdit(trackId: TrackId) {
    const track = getPossibleTrack(camMap, trackId, selectedCamera.value);
    if (track) {
      //seekNearest(track);
      const editing = trackId === selectedTrackId.value ? (!editingTrack.value) : true;
      handleSelectTrack(trackId, editing);
      //Track doesn't exist for this specific camera
    } else if (getAnyTrack(camMap, trackId) !== undefined) {
      //track exists in other cameras we create in the current map using override
      handleAddTrackOrDetection(trackId);
      const camTrack = getPossibleTrack(camMap, trackId, selectedCamera.value);
      // now that we have a new track we select it for editing
      if (camTrack) {
        const editing = trackId === selectedTrackId.value;
        handleSelectTrack(trackId, editing);
      }
    }
  }

  function handleTrackClick(trackId: TrackId) {
    const track = getTracksMerged(camMap, trackId);
    // We want the closest frame doesn't matter what camera it is in
    seekNearest(track);
    handleSelectTrack(trackId, editingTrack.value);
  }

  function handleSelectNext(delta: number) {
    const newTrack = selectNextTrack(delta);
    if (newTrack !== null) {
      handleSelectTrack(newTrack, false);
      seekNearest(getAnyTrack(camMap, newTrack));
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
    if (!mergeInProgress.value && selectedTrackId.value !== null) {
      /* If no merge in progress and there is a selected track id */
      mergeList.value = [selectedTrackId.value];
      /* no editing in merge mode */
      selectTrack(selectedTrackId.value, false);
    } else {
      mergeList.value = [];
    }
    return mergeList.value;
  }

  /**
   * Merge: Commit the merge list
   * Merging can only be done in the same selected camera.
   */
  function handleCommitMerge() {
    if (mergeList.value.length >= 2) {
      const track = getTrack(camMap, mergeList.value[0], selectedCamera.value);
      const otherTrackIds = mergeList.value.slice(1);
      track.merge(otherTrackIds.map(
        (trackId) => getTrack(camMap, trackId, selectedCamera.value),
      ));
      handleRemoveTrack(otherTrackIds, true);
      handleToggleMerge();
      handleSelectTrack(track.trackId, false);
    }
  }

  function handleStartLinking(camera: string) {
    if (!linkingState.value && selectedTrackId.value !== null) {
      linkingState.value = true;
      if (camMap.has(camera)) {
        linkingCamera.value = camera;
      } else {
        throw Error(`Camera: ${camera} does not exist in the system for linking`);
      }
    } else if (selectedTrackId.value === null) {
      throw Error('Cannot start Linking without a track selected');
    }
  }

  function handleStopLinking() {
    linkingState.value = false;
    linkingTrack.value = null;
    linkingCamera.value = '';
  }

  /* Subscribe to recipe activation events */
  recipes.forEach((r) => r.bus.$on('activate', handleSetAnnotationState));
  /* Unsubscribe before unmount */
  onBeforeUnmount(() => {
    recipes.forEach((r) => r.bus.$off('activate', handleSetAnnotationState));
  });

  return {
    editingMode,
    editingDetails,
    mergeList,
    mergeInProgress,
    linkingTrack,
    linkingState,
    linkingCamera,
    visibleModes,
    selectedFeatureHandle,
    selectedKey,
    handler: {
      commitMerge: handleCommitMerge,
      toggleMerge: handleToggleMerge,
      trackAdd: handleAddTrackOrDetection,
      trackAbort: handleEscapeMode,
      trackEdit: handleTrackEdit,
      trackSeek: handleTrackClick,
      trackSelect: handleSelectTrack,
      trackSelectNext: handleSelectNext,
      trackTypeChange: handleTrackTypeChange,
      updateRectBounds: handleUpdateRectBounds,
      updateGeoJSON: handleUpdateGeoJSON,
      removeTrack: handleRemoveTrack,
      removePoint: handleRemovePoint,
      removeAnnotation: handleRemoveAnnotation,
      selectFeatureHandle: handleSelectFeatureHandle,
      setAnnotationState: handleSetAnnotationState,
      unstageFromMerge: handleUnstageFromMerge,
      startLinking: handleStartLinking,
      stopLinking: handleStopLinking,
    },
  };
}
