/// <reference types="jest" />
import Vue from 'vue';
import CompositionApi, { watchEffect } from '@vue/composition-api';
import useTrackStore, { getTrack } from './useTrackStore';

Vue.use(CompositionApi);

describe('useTrackStore', () => {
  it('can add and remove tracks', () => {
    const ts = useTrackStore({ markChangesPending: () => null });
    const t0 = ts.addTrack(20, 'foo');
    const t1 = ts.addTrack(10, 'foo');
    const trackMap = ts.camMap.get('singleCam');
    expect(trackMap).toBeTruthy();
    if (trackMap) {
      expect(Array.from(trackMap.keys()).length).toBe(2);
      expect(ts.sortedTracks.value[0].trackId).toBe(1);
      expect(ts.intervalTree.search([10, 10]).length).toBe(1);
      expect(ts.intervalTree.search([10, 20]).length).toBe(2);

      ts.removeTrack(t1.trackId);
      expect(Array.from(trackMap.keys()).length).toBe(1);
      expect(ts.sortedTracks.value[0].trackId).toBe(0);
      expect(ts.intervalTree.search([10, 10]).length).toBe(0);
      expect(ts.intervalTree.search([10, 20]).length).toBe(1);

      ts.removeTrack(t0.trackId);
      expect(Array.from(trackMap.keys()).length).toBe(0);
      expect(ts.sortedTracks.value.length).toBe(0);
      expect(ts.intervalTree.search([10, 10]).length).toBe(0);
      expect(ts.intervalTree.search([10, 20]).length).toBe(0);
    }
  });

  it('can insert and delete single-frame detections', () => {
    const ts = useTrackStore({ markChangesPending: () => null });
    ts.addTrack(0, 'foo');
    const t1 = ts.addTrack(0, 'bar');
    const trackMap = ts.camMap.get('singleCam');
    expect(trackMap).toBeTruthy();
    if (trackMap) {
      expect(Array.from(trackMap.keys()).length).toBe(2);

      ts.removeTrack(t1.trackId);
      expect(Array.from(trackMap.keys()).length).toBe(1);
      expect(ts.intervalTree.search([0, 0])).toStrictEqual(['0']);
    }
  });

  it('marks changes pending when a track updates', () => {
    let didCall = false;
    const markChangesPending = () => { didCall = true; };
    const ts = useTrackStore({ markChangesPending });
    ts.addTrack(0, 'foo');
    expect(didCall).toEqual(true);
  });

  it('throws an error when you access a track that is missing', () => {
    const markChangesPending = () => null;
    const ts = useTrackStore({ markChangesPending });
    expect(() => getTrack(ts.camMap, 0, 'singleCam')).toThrow('TrackId 0 not found in trackMap with cameraName singleCam');
    ts.addTrack(1000, 'foo');
    expect(getTrack(ts.camMap, 0, 'singleCam')).toBeTruthy();
  });

  it('updates a reactive list when member tracks change', async () => {
    const ts = useTrackStore({ markChangesPending: () => null });
    const track = ts.addTrack(0, 'foo');

    let called = false;

    watchEffect(() => {
      if (ts.sortedTracks.value.length) {
        called = true;
      }
    });

    track.setAttribute('foo', 'bar');
    await Vue.nextTick();
    expect(called).toBeTruthy();
    called = false;

    track.setFeature({
      keyframe: true,
      frame: 0,
    });
    await Vue.nextTick();
    expect(called).toBeTruthy();
    called = false;

    track.setType('foo');
    await Vue.nextTick();
    expect(called).toBeTruthy();
    called = false;
  });
});
