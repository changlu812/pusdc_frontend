from flask import Flask, render_template, abort,request,Response
import os

app = Flask(__name__)
# 首页
@app.route('/')
def index():
  return render_template('index.html')

# skill路由
@app.route('/skill')
def skill_page():
  return render_template('skill.html')

# zentra路由
@app.route('/zentra/<action>')
def zentra_pages(action):
  template_name = f"zentra_{action}.html"
  if os.path.exists(os.path.join(app.template_folder,template_name)):
    return render_template(template_name)
  abort(404)

# Base系列路由
@app.route('/base/<action>')
def base_pages(action):
  template_name = f"base_{action}.html"
  if os.path.exists(os.path.join(app.template_folder,template_name)):
    return render_template(template_name)
  abort(404)

# Email系列路由
@app.route('/email/<action>')
def email_pages(action):
  template_name = f"email_{action}.html"
  if os.path.exists(os.path.join(app.template_folder,template_name)):
    return render_template(template_name)
  abort(404)

if __name__ == '__main__':
  app.run(host='127.0.0.1',port=5000,debug=True)