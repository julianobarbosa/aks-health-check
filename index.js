#!/usr/bin/env node

//
// Imports
//
import { executeCommand, getKubernetesJson, doesResourceExist } from './helpers/commandHelpers.js'
import { Command } from "commander"
import chalk from "chalk"
import * as Development from './modules/development.js';
import * as ImageManagement from './modules/imageManagement.js';
import * as ClusterSetup from './modules/clusterSetup.js';
import * as DisasterRecovery from './modules/disasterRecovery.js';
import { equalsIgnoreCase } from './helpers/stringCompare.js';

//
// Main function
//
async function main(options) {

  // Sanity check the required programs are installed
  await executeCommand("kubectl");
  await executeCommand("az");

  // Parse container registries
  var registriesArr = options.imageRegistries ? options.imageRegistries.split(',') : [];

  // Begin pulling data
  console.log(chalk.bgWhite(chalk.black('               Downloading Infrastructure Data               ')));

  // Get cluster details
  console.log(chalk.blue("Fetching cluster information..."));
  var commandResults = await executeCommand(`az aks show -g ${options.resourceGroup} -n ${options.name}`);
  var clusterDetails = JSON.parse(commandResults.stdout);

  // Get container registries
  var containerRegistries = [];
  if (registriesArr.length)
  {
    console.log(chalk.blue("Fetching Azure Container Registry information..."));
    var commandResults = await executeCommand(`az acr list`);
    containerRegistries = JSON.parse(commandResults.stdout);
    containerRegistries = containerRegistries.filter(x => registriesArr.some(y => equalsIgnoreCase(y, x.name)));
  }

  // Get kube credentials
  console.log(chalk.blue("Refreshing kubernetes credentials..."));
  await executeCommand(`az aks get-credentials -g ${options.resourceGroup} -n ${options.name} --admin`);

  // Fetch all the namespaces
  console.log(chalk.blue("Fetching all namespaces..."));
  var namespaces = await getKubernetesJson('kubectl get ns', options);

  // Fetch all the pods
  console.log(chalk.blue("Fetching all pods..."));
  var pods = await getKubernetesJson('kubectl get pods --all-namespaces', options);

  // Fetch all the deployments
  console.log(chalk.blue("Fetching all deployments..."));
  var deployments = await getKubernetesJson('kubectl get deployments --all-namespaces', options);

  // Fetch all the services
  console.log(chalk.blue("Fetching all services..."));
  var services = await getKubernetesJson('kubectl get svc --all-namespaces', options);

  // Fetch all the config maps
  console.log(chalk.blue("Fetching all config maps..."));
  var configMaps = await getKubernetesJson('kubectl get configmap --all-namespaces', options);

  // Fetch all the secrets
  console.log(chalk.blue("Fetching all secrets..."));
  var secrets = await getKubernetesJson('kubectl get secret --all-namespaces', options);

  // Fetch all the horizontal pod autoscalers
  console.log(chalk.blue("Fetching all Horizontal Pod AutoScalers..."));
  var autoScalers = await getKubernetesJson('kubectl get hpa --all-namespaces', options);

  var hasConstraintTemplates = await doesResourceExist("constrainttemplates");
  var constraintTemplates = null;
  if (hasConstraintTemplates){
    // Fetch all the constraint templates (Open Policy Agent)
    console.log(chalk.blue("Fetching all Constraint Templates..."));
    constraintTemplates = await getKubernetesJson('kubectl get constrainttemplate');
  }  

  // Check development items
  console.log();
  console.log(chalk.bgWhite(chalk.black('               Scanning Development Items               ')));
  Development.checkForLivenessProbes(pods);
  Development.checkForReadinessProbes(pods);
  Development.checkForStartupProbes(pods);
  Development.checkForPreStopHooks(pods);
  Development.checkForSingleReplicas(deployments);
  Development.checkForTags([namespaces.items, pods.items, deployments.items, services.items, configMaps.items, secrets.items]);
  Development.checkForHorizontalPodAutoscalers(namespaces, autoScalers);
  Development.checkForAzureSecretsStoreProvider(pods);
  Development.checkForAzureManagedPodIdentity(clusterDetails);
  Development.checkForPodsInDefaultNamespace(pods);
  Development.checkForPodsWithoutRequestsOrLimits(pods);
  Development.checkForPodsWithDefaultSecurityContext(pods);

  // Check image management items
  console.log();
  console.log(chalk.bgWhite(chalk.black('               Scanning Image Management Items               ')));
  if (hasConstraintTemplates){
    ImageManagement.checkForAllowedImages(constraintTemplates);
    ImageManagement.checkForNoPrivilegedContainers(constraintTemplates);
  }  
  await ImageManagement.checkForAksAcrRbacIntegration(clusterDetails, containerRegistries);
  ImageManagement.checkForPrivateEndpointsOnRegistries(containerRegistries);
  ImageManagement.checkForRuntimeContainerSecurity(pods);

  // Check cluster setup items
  console.log();
  console.log(chalk.bgWhite(chalk.black('               Scanning Cluster Setup Items               ')));
  ClusterSetup.checkForAuthorizedIpRanges(clusterDetails);
  ClusterSetup.checkForManagedAadIntegration(clusterDetails);
  ClusterSetup.checkForAutoscale(clusterDetails);
  ClusterSetup.checkForKubernetesDashboard(pods);
  ClusterSetup.checkForMultipleNodePools(clusterDetails);

  // Check disaster recovery items
  console.log();
  console.log(chalk.bgWhite(chalk.black('               Scanning Disaster Recovery Items               ')));
  DisasterRecovery.checkForAvailabilityZones(clusterDetails);
  DisasterRecovery.checkForControlPlaneSla(clusterDetails);
  DisasterRecovery.checkForVelero(pods);
}

//
// Entrypoint
//
(async () => {
  try {

    // Build up the program
    const program = new Command();
    program
      .name('boxboat-aks-healthcheck')
      .description('Healthchecks an AKS cluster using BoxBoat best practices')
      .requiredOption('-g, --resource-group <group>', 'Resource group of AKS cluster')
      .requiredOption('-n, --name <name>', 'Name of AKS cluster')
      .option('-r, --image-registries <registries>', 'A comma-separated list of Azure Container Registry names used with the cluster')
      .option('-i, --ignore-namespaces <namespaces>', 'A comma-separated list of namespaces to ignore when doing analysis');

    // Parse command
    program.parse();

    // Execute main
    const opts = program.opts();
    await main(opts);

    // If we make it here, main has completed
    // exit the process to stop any promises that are waiting to timeout
    process.exit(0);
  } catch (e) {
    console.log(chalk.red(`An unexpected error occurred: ${e}`));
    process.exit(1);
  }
})();
