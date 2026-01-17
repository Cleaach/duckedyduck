const path = require('path');

module.exports = {
  target: 'node', // VS Code extensions run in a Node.js context
  mode: 'production', // Fixes the 'mode' warning
  entry: './src/extension.ts', // <--- This tells Webpack where to start
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js', // The bundled output file
    libraryTarget: 'commonjs',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },
  devtool: 'source-map', // Helps with debugging
  externals: {
    vscode: 'commonjs vscode', // Important: Don't bundle the 'vscode' module!
  },
  resolve: {
    extensions: ['.ts', '.js'], // Support these file extensions
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
};