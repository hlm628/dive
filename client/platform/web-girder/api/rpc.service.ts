import girderRest from 'platform/web-girder/plugins/girder';
import { Pipe } from 'dive-common/apispec';

function postProcess(folderId: string, skipJobs = false, skipTranscoding = false, additive = false, additivePrepend = '') {
  return girderRest.post(`dive_rpc/postprocess/${folderId}`, null, {
    params: {
      skipJobs, skipTranscoding, additive, additivePrepend,
    },
  });
}

function runPipeline(itemId: string, pipeline: Pipe) {
  return girderRest.post('dive_rpc/pipeline', null, {
    params: {
      folderId: itemId,
      pipeline,
    },
  });
}

function runTraining(
  folderIds: string[],
  pipelineName: string,
  config: string,
  annotatedFramesOnly: boolean,
  labelText?: string,
  fineTuneModel?: {
    name: string;
    type: string;
    path?: string;
    folderId?: string;
  },
) {
  return girderRest.post('dive_rpc/train', { folderIds, labelText, fineTuneModel }, {
    params: {
      pipelineName, config, annotatedFramesOnly,
    },
  });
}

function convertLargeImage(folderId: string) {
  return girderRest.post(`dive_rpc/convert_large_image/${folderId}`, null, {});
}

export {
  convertLargeImage,
  postProcess,
  runPipeline,
  runTraining,
};
