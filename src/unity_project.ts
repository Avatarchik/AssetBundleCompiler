import { logger } from '@mitm/unityinvoker';
import * as fs from 'fs';
import * as fsx from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { BuildContext } from './build_context';
import * as buildTargets from './build_targets';
import * as streamMaker from './stream_maker';
import * as unity from './unity_invoker';

export type BuildTarget = (keyof typeof buildTargets)|string;

export const ProjectDirectory = path.join(os.tmpdir(), 'AssetBundleCompiler');
const CompilerScriptSource = path.resolve(`${__dirname}/../../resources/AssetBundleCompiler.cs`);
const CompilerScriptDest = path.resolve(`${ProjectDirectory}/Assets/Editor/AssetBundleCompiler.cs`);

function copyStreamInDirectory(fileStream: fs.ReadStream, directory: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const fileName = path.basename(fileStream.path as string);
        const fileDestStream = fsx.createWriteStream(path.join(directory, fileName));

        fileStream.pipe(fileDestStream);

        fileDestStream.on('finish', resolve);
        fileDestStream.on('error', reject);
    });
}

async function copyStreamsInDirectory(fileStreams: fs.ReadStream[], directory: string): Promise<void> {
    const copyTasks = fileStreams.map(stream => copyStreamInDirectory(stream, directory));

    await Promise.all(copyTasks);
}

export async function shouldCreateProject(): Promise<boolean> {
    try {
        await fsx.access(ProjectDirectory, fsx.constants.R_OK | fsx.constants.W_OK);
        return false;
    } catch (err) {
        return true;
    }
}

export async function copyEditorScript(): Promise<void> {
    await fsx.mkdirp(path.dirname(CompilerScriptDest));
    await fsx.copy(CompilerScriptSource, CompilerScriptDest);
}

export async function warmupProject(context: BuildContext): Promise<void> {
    if (await shouldCreateProject()) {
        await unity.createProject(ProjectDirectory);
        await copyEditorScript();
    }

    await fsx.mkdir(context.editorScriptsDir);
    await fsx.mkdir(context.assetsDir);
    await fsx.mkdir(context.assetBundleDir);
}

export async function copyEditorScriptsInProject(
    context: BuildContext,
    scriptsStreams: fs.ReadStream[]
): Promise<void> {
    await copyStreamsInDirectory(scriptsStreams, context.editorScriptsDir);
}

export async function copyAssetsInProject(
    context: BuildContext,
    assetStreams: fs.ReadStream[]
): Promise<void> {
    await copyStreamsInDirectory(assetStreams, context.assetsDir);
}

export async function generateAssetBundle(
    context: BuildContext,
    fileStreams: fs.ReadStream[],
    buildOptions: Set<string>,
    buildTarget: BuildTarget,
    unityLogger?: logger.SimpleLogger,
    signalAssetProcessed?: logger.SimpleLogger
): Promise<void> {
    const assetNames = fileStreams.map(fileStream => path.basename(fileStream.path as string));

    await unity.generateAssetBundle(
        ProjectDirectory,
        assetNames,
        context.assetBundleDir,
        'assetbundle',
        buildOptions,
        buildTarget,
        unityLogger,
        signalAssetProcessed
    );
}

export async function moveGeneratedAssetBundle(
    context: BuildContext,
    finalDest: string|fs.WriteStream,
    overwrite: boolean
): Promise<void> {
    const assetBundlePath = path.resolve(`${context.assetBundleDir}/assetbundle`);

    if (typeof finalDest === 'string') {
        await fsx.move(assetBundlePath, finalDest, { overwrite });
    } else if (streamMaker.isWriteStream(finalDest)) {
        if (!overwrite) {
            try {
                await fsx.access(finalDest.path);
                throw new Error(`File ${finalDest.path} already exists, overwrite option is false, aborting.`);
            } finally { /* pass */ }
        }

        const assetBundleStream = fsx.createReadStream(assetBundlePath);

        return new Promise<void>((resolve, reject) => {
            assetBundleStream.pipe(finalDest as fs.WriteStream)
                .on('finish', () => resolve())
                .on('error', (err: Error) => reject(err));
        });
    }
}

export async function cleanupProject(context: BuildContext): Promise<void> {
    await fsx.remove(context.editorScriptsDir);
    await fsx.remove(context.editorScriptsDir + '.meta');
    await fsx.remove(context.assetsDir);
    await fsx.remove(context.assetsDir + '.meta');
    await fsx.remove(context.assetBundleDir);
}
